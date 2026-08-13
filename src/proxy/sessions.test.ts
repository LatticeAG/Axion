import { describe, expect, it } from "vitest";
import {
  extractSessionMetadataId,
  fetchSessionMetadata,
  fetchSessions,
  getSessionRegistryStub,
  SESSION_REGISTRY_NAME,
} from "./sessions";
import type { Env } from "./types";

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function makeEnv(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
): { env: Env; seenNames: string[]; seenRequests: SeenRequest[] } {
  const seenNames: string[] = [];
  const seenRequests: SeenRequest[] = [];
  const stub = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      seenRequests.push({ url: input.toString(), init });
      return responder(input, init);
    },
  } as unknown as DurableObjectStub;
  const env = {
    UPSTREAM_API_URL: "https://api.openai.com",
    SESSION: {} as DurableObjectNamespace,
    SESSION_REGISTRY: {
      idFromName: (name: string) => {
        seenNames.push(name);
        return {} as DurableObjectId;
      },
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
  } satisfies Env;
  return { env, seenNames, seenRequests };
}

describe("fetchSessions", () => {
  it("uses the singleton registry and forces public pages to 20 records", async () => {
    const { env, seenNames, seenRequests } = makeEnv(() =>
      new Response(JSON.stringify({ sessions: [], nextCursor: null }), {
        headers: { "X-Registry": "yes" },
      }),
    );

    const response = await fetchSessions(
      new Request("https://worker.example/api/sessions?limit=99&cursor=cursor-value"),
      env,
    );

    expect(seenNames).toEqual([SESSION_REGISTRY_NAME]);
    const target = new URL(seenRequests[0]!.url);
    expect(target.pathname).toBe("/sessions");
    expect(target.searchParams.get("limit")).toBe("20");
    expect(target.searchParams.get("cursor")).toBe("cursor-value");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ sessions: [], nextCursor: null });
  });

  it("passes registry failures through as a safe 502 JSON response", async () => {
    const { env } = makeEnv(() => {
      throw new Error("registry unavailable");
    });

    const response = await fetchSessions(
      new Request("https://worker.example/api/sessions"),
      env,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: "Failed to reach session registry: registry unavailable" },
    });
  });
});

describe("fetchSessionMetadata", () => {
  it("forwards one decoded id to the registry", async () => {
    const { env, seenRequests } = makeEnv(() =>
      new Response(JSON.stringify({ id: "a/b" }), { status: 200 }),
    );

    const response = await fetchSessionMetadata(env, "/api/sessions/a%2Fb");

    expect(response.status).toBe(200);
    expect(new URL(seenRequests[0]!.url).pathname).toBe("/session/a%2Fb");
    expect(await response.json()).toEqual({ id: "a/b" });
  });

  it("does not let a nested route be mistaken for session metadata", async () => {
    const { env, seenRequests } = makeEnv(() => new Response("unexpected"));

    const response = await fetchSessionMetadata(env, "/api/sessions/a/usage");

    expect(response.status).toBe(400);
    expect(seenRequests).toEqual([]);
  });
});

describe("registry helpers", () => {
  it("returns the shared stub and parses a single encoded segment", () => {
    const { env, seenNames } = makeEnv(() => new Response("{}"));

    expect(getSessionRegistryStub(env)).toBeDefined();
    expect(seenNames).toEqual([SESSION_REGISTRY_NAME]);
    expect(extractSessionMetadataId("/api/sessions/a%2Fb")).toBe("a/b");
    expect(extractSessionMetadataId("/api/sessions/a/usage")).toBeNull();
    expect(extractSessionMetadataId("/api/sessions/")).toBeNull();
  });
});
