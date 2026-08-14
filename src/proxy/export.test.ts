import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import type { BeliefBatch } from "../state/sessionBeliefs";
import type { SessionMetadata } from "../state/sessionRegistry";
import {
  fetchAllSessionsExport,
  fetchSessionExport,
  parseSessionExportPath,
  renderSessionMarkdown,
  sessionExportFilename,
  type SessionStateExportSnapshot,
} from "./export";
import { MemoryRateLimitCache, setRateLimitCacheForTests } from "./rateLimit";
import type { Env } from "./types";

function metadata(id: string, updatedAt = 2_000): SessionMetadata {
  return {
    id,
    createdAt: 1_000,
    updatedAt,
    modelName: "gpt-4.1-mini",
    provider: "openai",
    sessionName: `Run ${id}`,
    messageCount: 2,
    tokenUsage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  };
}

function belief(
  id: string,
  overrides: Partial<ExtractedBelief> = {},
): ExtractedBelief {
  return {
    id,
    sessionId: "run-1",
    type: "causal",
    belief: "the access token expired",
    confidence: 0.63,
    timestamp: 1_500,
    rawText: "because the access token expired",
    line: 4,
    ...overrides,
  };
}

function snapshot(id: string): SessionStateExportSnapshot {
  const timelineBelief = belief(`${id}-belief`);
  const rawBelief = { ...timelineBelief, confidence: 0.7 };
  const batches: BeliefBatch[] = [
    {
      beliefs: [rawBelief],
      rawText: "Because the access token expired.",
      timestamp: 1_500,
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      modelName: "gpt-4.1-mini",
      provider: "openai",
      messageCount: 2,
    },
  ];
  return {
    sessionId: id,
    beliefs: [timelineBelief],
    batches,
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    calls: 1,
  };
}

interface FixtureOptions {
  metadataById?: Record<string, SessionMetadata>;
  snapshotsById?: Record<string, SessionStateExportSnapshot>;
  page?: { sessions: SessionMetadata[]; nextCursor: string | null };
  registryStatus?: number;
  sessionStatus?: number;
  malformedSnapshot?: boolean;
}

function makeEnv(options: FixtureOptions = {}) {
  const metadataById = options.metadataById ?? { "run-1": metadata("run-1") };
  const snapshotsById = options.snapshotsById ?? { "run-1": snapshot("run-1") };
  const registryRequests: URL[] = [];
  const sessionRequests: Array<{ id: string; url: URL }> = [];

  const registryStub = {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      registryRequests.push(url);
      if (options.registryStatus) {
        return new Response(JSON.stringify({ error: { message: "registry unavailable" } }), {
          status: options.registryStatus,
        });
      }
      if (url.pathname.startsWith("/session/")) {
        const id = decodeURIComponent(url.pathname.slice("/session/".length));
        const value = metadataById[id];
        if (!value) {
          return new Response(JSON.stringify({ error: { message: "Session not found" } }), {
            status: 404,
          });
        }
        return new Response(JSON.stringify(value));
      }
      return new Response(
        JSON.stringify(options.page ?? { sessions: Object.values(metadataById), nextCursor: null }),
      );
    },
  } as unknown as DurableObjectStub;

  const sessionNamespace = {
    idFromName: (id: string) => id as unknown as DurableObjectId,
    get: (durableId: DurableObjectId) =>
      ({
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const id = String(durableId);
          const url = new URL(String(input));
          sessionRequests.push({ id, url });
          if (options.sessionStatus) {
            return new Response(JSON.stringify({ error: { message: "state unavailable" } }), {
              status: options.sessionStatus,
            });
          }
          if (options.malformedSnapshot) return new Response(JSON.stringify({ bad: true }));
          const value = snapshotsById[id] ?? snapshot(id);
          return new Response(JSON.stringify(value));
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;

  const registryNamespace = {
    idFromName: () => ({}) as DurableObjectId,
    get: () => registryStub,
  } as unknown as DurableObjectNamespace;

  return {
    env: {
      UPSTREAM_API_URL: "https://upstream.example",
      AXION_OPEN_READ: "true",
      SESSION: sessionNamespace,
      SESSION_REGISTRY: registryNamespace,
      ASSETS: {} as Fetcher,
    } satisfies Env,
    registryRequests,
    sessionRequests,
  };
}

describe("export path helpers", () => {
  it("parses one safely encoded session segment and rejects malformed paths", () => {
    expect(parseSessionExportPath("/api/sessions/run%2Fone/export/json")).toEqual({
      sessionId: "run/one",
      format: "json",
    });
    expect(parseSessionExportPath("/api/sessions/run%20one/export/markdown")).toEqual({
      sessionId: "run one",
      format: "markdown",
    });
    expect(parseSessionExportPath("/api/sessions/run/one/export/json")).toBeNull();
    expect(parseSessionExportPath("/api/sessions/%E0%A4%A/export/json")).toBeNull();
    expect(parseSessionExportPath("/api/sessions/run/export/xml")).toBeNull();
  });

  it("makes attachment filenames safe and stable", () => {
    expect(sessionExportFilename("run / one", "json")).toBe("axion-session-run-one.json");
    expect(sessionExportFilename("***", "markdown")).toBe("axion-session-session.md");
  });
});

describe("fetchSessionExport", () => {
  it("joins registry metadata with raw session batches in a downloadable JSON dump", async () => {
    const fixture = makeEnv({
      metadataById: { "run/one": metadata("run/one") },
      snapshotsById: { "run/one": snapshot("run/one") },
    });

    const response = await fetchSessionExport(
      new Request("https://worker.example/api/sessions/run%2Fone/export/json"),
      fixture.env,
      "/api/sessions/run%2Fone/export/json",
    );
    const body = (await response.json()) as {
      metadata: SessionMetadata;
      sessionId: string;
      beliefs: ExtractedBelief[];
      batches: BeliefBatch[];
      usage: { total_tokens: number };
      calls: number;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="axion-session-run-one.json"',
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fixture.registryRequests[0]?.pathname).toBe("/session/run%2Fone");
    expect(fixture.sessionRequests[0]?.url.toString()).toBe(
      "https://internal/export?sessionId=run%2Fone",
    );
    expect(body.metadata).toEqual(metadata("run/one"));
    expect(body.sessionId).toBe("run/one");
    expect(body.beliefs[0]?.confidence).toBeCloseTo(0.63, 8);
    expect(body.batches[0]?.beliefs[0]?.confidence).toBeCloseTo(0.7, 8);
    expect(body.batches[0]?.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
    expect(body.usage.total_tokens).toBe(18);
    expect(body.calls).toBe(1);
    expect(body.batches[0]?.rawText).toBe("");
    expect(body.beliefs[0]?.rawText).toBe("");
  });

  it("includes batch rawText only when includeRaw=1, and never in Markdown", async () => {
    const fixture = makeEnv();
    const withRaw = await fetchSessionExport(
      new Request("https://worker.example/api/sessions/run-1/export/json?includeRaw=1"),
      fixture.env,
      "/api/sessions/run-1/export/json",
    );
    const withRawBody = (await withRaw.json()) as {
      batches: BeliefBatch[];
      beliefs: ExtractedBelief[];
    };
    expect(withRawBody.batches[0]?.rawText).toBe("Because the access token expired.");
    expect(withRawBody.beliefs[0]?.rawText).toBe("");

    const markdown = await fetchSessionExport(
      new Request("https://worker.example/api/sessions/run-1/export/markdown?includeRaw=1"),
      fixture.env,
      "/api/sessions/run-1/export/markdown",
    );
    const text = await markdown.text();
    expect(text).not.toContain("Because the access token expired.");
    expect(text).toContain("- Belief: the access token expired");
  });

  it("returns a deterministic human-readable Markdown report", async () => {
    const fixture = makeEnv();
    const response = await fetchSessionExport(
      new Request("https://worker.example/api/sessions/run-1/export/markdown"),
      fixture.env,
      "/api/sessions/run-1/export/markdown",
    );
    const text = await response.text();

    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="axion-session-run-1.md"',
    );
    expect(text).toContain("# Axion session report");
    expect(text).toContain("- Session ID: `run-1`");
    expect(text).toContain("- Prompt tokens: 11");
    expect(text).toContain("### 1. causal · 63%");
    expect(text).toContain("- Belief: the access token expired");
    expect(text).toContain("1970-01-01T00:00:01.500Z");
    expect(text).not.toContain("Because the access token expired.");
    expect(text).toBe(renderSessionMarkdown({
      metadata: metadata("run-1"),
      ...snapshot("run-1"),
    }));
  });

  it("renders empty timelines and escapes Markdown field content predictably", () => {
    const report = renderSessionMarkdown({
      metadata: { ...metadata("run-1"), sessionName: "run | one" },
      sessionId: "run-1",
      beliefs: [
        belief("special", {
          belief: "need | review\nnow",
          evidence: "log | trace",
          actionTaken: "retry",
        }),
      ],
      batches: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      calls: 0,
    });
    const empty = renderSessionMarkdown({
      metadata: metadata("empty"),
      sessionId: "empty",
      beliefs: [],
      batches: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      calls: 0,
    });

    expect(report).toContain("run \\| one");
    expect(report).toContain("need \\| review now");
    expect(report).toContain("- Evidence: log \\| trace");
    expect(empty).toContain("No beliefs were extracted for this session.");
  });

  it("passes registry failures through and turns invalid state snapshots into 502s", async () => {
    const missing = makeEnv({ registryStatus: 404 });
    const missingResponse = await fetchSessionExport(
      new Request("https://worker.example/api/sessions/run-1/export/json"),
      missing.env,
      "/api/sessions/run-1/export/json",
    );
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.headers.get("Cache-Control")).toBe("no-store");

    const malformed = makeEnv({ malformedSnapshot: true });
    const malformedResponse = await fetchSessionExport(
      new Request("https://worker.example/api/sessions/run-1/export/json"),
      malformed.env,
      "/api/sessions/run-1/export/json",
    );
    expect(malformedResponse.status).toBe(502);
    expect(await malformedResponse.json()).toEqual({
      error: { message: "Failed to export session" },
    });
  });
});

describe("fetchAllSessionsExport", () => {
  beforeEach(() => {
    setRateLimitCacheForTests(new MemoryRateLimitCache());
  });

  afterEach(() => {
    setRateLimitCacheForTests(undefined);
  });

  it("exports one registry page in registry order and preserves the opaque cursor", async () => {
    const cursor = "%5B123%2C%22run-a%22%5D";
    const newest = metadata("newest", 3_000);
    const older = metadata("older", 2_000);
    const fixture = makeEnv({
      metadataById: { newest, older },
      snapshotsById: { newest: snapshot("newest"), older: snapshot("older") },
      page: { sessions: [newest, older], nextCursor: "next-page" },
    });

    const response = await fetchAllSessionsExport(
      new Request(`https://worker.example/api/export/all?cursor=${encodeURIComponent(cursor)}`),
      fixture.env,
    );
    const body = (await response.json()) as {
      sessions: Array<{ metadata: SessionMetadata; sessionId: string }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="axion-sessions.json"',
    );
    expect(fixture.registryRequests[0]?.pathname).toBe("/sessions");
    expect(fixture.registryRequests[0]?.searchParams.get("limit")).toBe("20");
    expect(fixture.registryRequests[0]?.searchParams.get("cursor")).toBe(cursor);
    expect(body.sessions.map((entry) => entry.sessionId)).toEqual(["newest", "older"]);
    expect(body.sessions.map((entry) => entry.metadata.id)).toEqual(["newest", "older"]);
    expect(body.nextCursor).toBe("next-page");
    expect(fixture.sessionRequests.map((entry) => entry.id)).toEqual(["newest", "older"]);
  });

  it("returns a safe 502 response when a session state read fails", async () => {
    const fixture = makeEnv({
      page: { sessions: [metadata("run-1")], nextCursor: null },
      sessionStatus: 500,
    });

    const response = await fetchAllSessionsExport(
      new Request("https://worker.example/api/export/all"),
      fixture.env,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
