import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import type { SessionMetadata } from "../state/sessionRegistry";
import { fetchSearch, SESSION_REGISTRY_NAME } from "./search";
import { MemoryRateLimitCache, setRateLimitCacheForTests } from "./rateLimit";
import type { Env } from "./types";

interface RegistryPageFixture {
  sessions: SessionMetadata[];
  nextCursor?: string | null;
  status?: number;
}

function session(id: string, updatedAt: number): SessionMetadata {
  return {
    id,
    createdAt: updatedAt - 1,
    updatedAt,
    modelName: "gpt-4.1-mini",
    provider: "openai",
    sessionName: `Run ${id}`,
    messageCount: 1,
    tokenUsage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function belief(
  id: string,
  overrides: Partial<ExtractedBelief> = {},
): ExtractedBelief {
  return {
    id,
    sessionId: "ignored-by-search",
    type: "causal",
    belief: "The access token expired",
    confidence: 0.7,
    timestamp: 100,
    rawText: "Because the access token expired.",
    line: 1,
    ...overrides,
  };
}

function makeEnv(options: {
  pages?: Record<string, RegistryPageFixture>;
  beliefs?: Record<string, ExtractedBelief[]>;
  registryThrows?: boolean;
  sessionStatus?: Record<string, number>;
} = {}) {
  const pages = options.pages ?? { "": { sessions: [], nextCursor: null } };
  const beliefs = options.beliefs ?? {};
  const registryRequests: URL[] = [];
  const sessionRequests: URL[] = [];

  const registryStub = {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      if (options.registryThrows) throw new Error("registry unavailable");
      const url = new URL(String(input));
      registryRequests.push(url);
      if (url.pathname === "/session") {
        const id = url.searchParams.get("id") ?? "";
        const found = Object.values(pages)
          .flatMap((page) => page.sessions)
          .find((item) => item.id === id);
        if (!found) {
          return new Response(JSON.stringify({ error: { message: "Session not found" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(found), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const key = url.searchParams.get("cursor") ?? "";
      const page = pages[key];
      if (!page) return new Response("missing page", { status: 500 });
      return new Response(
        JSON.stringify({
          sessions: page.sessions,
          nextCursor: page.nextCursor ?? null,
        }),
        { status: page.status ?? 200, headers: { "Content-Type": "application/json" } },
      );
    },
  } as unknown as DurableObjectStub;

  const sessionNamespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) =>
      ({
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = new URL(String(input));
          sessionRequests.push(url);
          const sessionId = String(id);
          const status = options.sessionStatus?.[sessionId] ?? 200;
          return new Response(
            JSON.stringify({ sessionId, beliefs: beliefs[sessionId] ?? [] }),
            { status, headers: { "Content-Type": "application/json" } },
          );
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;

  const registryNamespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      expect(String(id)).toBe(SESSION_REGISTRY_NAME);
      return registryStub;
    },
  } as unknown as DurableObjectNamespace;

  return {
    env: {
      UPSTREAM_API_URL: "https://upstream.example",
      AXION_OPEN_READ: "true",
      AXION_CURSOR_SECRET: "test-cursor-secret",
      SESSION: sessionNamespace,
      SESSION_REGISTRY: registryNamespace,
      ASSETS: {} as Fetcher,
    } as Env,
    registryRequests,
    sessionRequests,
  };
}

function request(query: string): Request {
  return new Request(`https://worker.example/api/search?${query}`);
}

describe("fetchSearch", () => {
  beforeEach(() => {
    setRateLimitCacheForTests(new MemoryRateLimitCache());
  });

  afterEach(() => {
    setRateLimitCacheForTests(undefined);
  });

  it("returns 400 before touching state when q is missing", async () => {
    const fixture = makeEnv();
    const response = await fetchSearch(request("type=causal"), fixture.env);

    expect(response.status).toBe(400);
    expect(fixture.registryRequests).toHaveLength(0);
    expect((await response.json()) as unknown).toEqual({
      error: { message: 'Query parameter "q" is required' },
    });
  });

  it("searches belief and evidence text and returns session context", async () => {
    const newest = session("newest", 30);
    const older = session("older", 20);
    const fixture = makeEnv({
      pages: { "": { sessions: [older, newest], nextCursor: null } },
      beliefs: {
        newest: [
          belief("wrong-type", { type: "planning", timestamp: 11 }),
          belief("evidence-hit", {
            belief: "The request failed",
            evidence: "Gateway timeout recorded by the trace",
            confidence: 0.8,
            timestamp: 12,
          }),
        ],
        older: [belief("too-low", { confidence: 0.3, timestamp: 13 })],
      },
    });

    const response = await fetchSearch(
      request("q=TIMEOUT&type=causal&minConfidence=0.5&maxConfidence=0.9"),
      fixture.env,
    );
    const body = (await response.json()) as {
      results: Array<{ session: SessionMetadata; belief: ExtractedBelief }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("x-axion-scans")).toBe("2");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.session).toEqual(newest);
    expect(body.results[0]?.belief.id).toBe("evidence-hit");
    expect(body.results[0]?.belief.rawText).toBe("");
    expect(body.nextCursor).toBeNull();
    // Search normalizes a registry page to the documented newest-first order.
    expect(fixture.sessionRequests.map((url) => url.searchParams.get("sessionId"))).toEqual([
      "newest",
      "older",
    ]);
  });

  it("paginates within one session without duplicating or skipping beliefs", async () => {
    const active = session("active", 10);
    const fixture = makeEnv({
      pages: { "": { sessions: [active], nextCursor: null } },
      beliefs: {
        active: [
          belief("old", { timestamp: 1 }),
          belief("middle", { timestamp: 2 }),
          belief("new", { timestamp: 3 }),
        ],
      },
    });

    const firstResponse = await fetchSearch(request("q=token&limit=2"), fixture.env);
    const first = (await firstResponse.json()) as {
      results: Array<{ belief: ExtractedBelief }>;
      nextCursor: string | null;
    };
    const secondResponse = await fetchSearch(
      request(`q=token&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
      fixture.env,
    );
    const second = (await secondResponse.json()) as {
      results: Array<{ belief: ExtractedBelief }>;
      nextCursor: string | null;
    };

    expect(first.results.map((result) => result.belief.id)).toEqual(["new", "middle"]);
    expect(second.results.map((result) => result.belief.id)).toEqual(["old"]);
    expect(second.nextCursor).toBeNull();
    expect(fixture.registryRequests.filter((url) => url.pathname === "/sessions")).toHaveLength(1);
  });

  it("resumes leftover sessions before fetching the next registry page", async () => {
    const recent = session("recent", 30);
    const pending = session("pending", 20);
    const final = session("final", 10);
    const fixture = makeEnv({
      pages: {
        "": { sessions: [recent, pending], nextCursor: "page-2" },
        "page-2": { sessions: [final], nextCursor: null },
      },
      beliefs: {
        recent: [belief("recent", { timestamp: 30 })],
        pending: [belief("pending", { timestamp: 20 })],
        final: [belief("final", { timestamp: 10 })],
      },
    });

    const first = (await (
      await fetchSearch(request("q=token&limit=1"), fixture.env)
    ).json()) as { nextCursor: string | null };
    const second = (await (
      await fetchSearch(
        request(`q=token&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
        fixture.env,
      )
    ).json()) as { results: Array<{ belief: ExtractedBelief }>; nextCursor: string | null };

    expect(second.results.map((result) => result.belief.id)).toEqual(["pending", "final"]);
    expect(second.nextCursor).toBeNull();
    expect(fixture.registryRequests.map((url) => `${url.pathname}?${url.searchParams.toString()}`)).toEqual([
      "/sessions?limit=20",
      "/session?id=pending",
      "/sessions?limit=20&cursor=page-2",
    ]);
  });

  it("binds cursors to q/type/confidence filters but permits a changed limit", async () => {
    const active = session("active", 10);
    const fixture = makeEnv({
      pages: { "": { sessions: [active], nextCursor: null } },
      beliefs: { active: [belief("one"), belief("two", { timestamp: 2 })] },
    });
    const first = (await (
      await fetchSearch(request("q=token&limit=1"), fixture.env)
    ).json()) as { nextCursor: string };

    const changedLimit = await fetchSearch(
      request(`q=token&limit=5&cursor=${encodeURIComponent(first.nextCursor)}`),
      fixture.env,
    );
    const changedQuery = await fetchSearch(
      request(`q=other&cursor=${encodeURIComponent(first.nextCursor)}`),
      fixture.env,
    );

    expect(changedLimit.status).toBe(200);
    expect(changedQuery.status).toBe(400);
    expect((await changedQuery.json()) as unknown).toEqual({
      error: { message: "Search cursor does not match this query" },
    });
  });

  it("returns a 400 for a malformed cursor", async () => {
    const fixture = makeEnv();
    const response = await fetchSearch(request("q=token&cursor=not-valid!"), fixture.env);

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: { message: "Invalid search cursor" },
    });
  });

  it("fails closed with 502 when registry or session state fails", async () => {
    const registryFailure = makeEnv({ registryThrows: true });
    const registryResponse = await fetchSearch(request("q=token"), registryFailure.env);

    const failedSession = session("failed", 1);
    const sessionFailure = makeEnv({
      pages: { "": { sessions: [failedSession], nextCursor: null } },
      sessionStatus: { failed: 500 },
    });
    const sessionResponse = await fetchSearch(request("q=token"), sessionFailure.env);

    expect(registryResponse.status).toBe(502);
    expect(sessionResponse.status).toBe(502);
    expect((await registryResponse.json()) as unknown).toEqual({
      error: { message: "Failed to search session state" },
    });
  });

  it("returns 503 when AXION_CURSOR_SECRET is unset", async () => {
    const fixture = makeEnv();
    delete fixture.env.AXION_CURSOR_SECRET;
    const response = await fetchSearch(request("q=token"), fixture.env);

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      error: { message: "Search cursor signing is not configured" },
    });
    expect(fixture.registryRequests).toHaveLength(0);
  });

  it("stops at the session scan budget and still returns a continuation cursor", async () => {
    const first = session("first", 30);
    const second = session("second", 20);
    const third = session("third", 10);
    const fixture = makeEnv({
      pages: { "": { sessions: [first, second, third], nextCursor: null } },
      beliefs: {
        first: [],
        second: [],
        third: [belief("late-hit")],
      },
    });
    fixture.env.AXION_SEARCH_MAX_SESSION_SCANS = "2";

    const response = await fetchSearch(request("q=token"), fixture.env);
    const body = (await response.json()) as {
      results: Array<{ belief: ExtractedBelief }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axion-scans")).toBe("2");
    expect(body.results).toEqual([]);
    expect(body.nextCursor).not.toBeNull();
    expect(fixture.sessionRequests.map((url) => url.searchParams.get("sessionId"))).toEqual([
      "first",
      "second",
    ]);

    const resumed = await fetchSearch(
      request(`q=token&cursor=${encodeURIComponent(body.nextCursor!)}`),
      fixture.env,
    );
    const resumedBody = (await resumed.json()) as {
      results: Array<{ belief: ExtractedBelief }>;
      nextCursor: string | null;
    };
    expect(resumed.status).toBe(200);
    expect(resumedBody.results.map((result) => result.belief.id)).toEqual(["late-hit"]);
    expect(resumedBody.results[0]?.belief.rawText).toBe("");
    expect(resumedBody.nextCursor).toBeNull();
  });
});
