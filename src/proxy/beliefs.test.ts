import { describe, expect, it } from "vitest";
import { extractSessionId, fetchBeliefs } from "./beliefs";
import type { Env } from "./types";

function makeEnv(
  options: {
    throws?: boolean;
    status?: number;
    body?: unknown;
    openRead?: boolean;
    readToken?: string;
  } = {},
) {
  const sessionNamespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () =>
      ({
        fetch: async () => {
          if (options.throws) throw new Error("do down");
          return new Response(
            JSON.stringify(
              options.body ?? {
                sessionId: "s1",
                beliefs: [
                  {
                    id: "b1",
                    sessionId: "s1",
                    type: "causal",
                    belief: "rain causes delay",
                    confidence: 0.7,
                    timestamp: 1,
                    rawText: "Because of rain.",
                    line: 1,
                  },
                ],
              },
            ),
            {
              status: options.status ?? 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;

  return {
    UPSTREAM_API_URL: "https://upstream.example",
    AXION_OPEN_READ: options.openRead === false ? undefined : "true",
    AXION_READ_TOKEN: options.readToken,
    SESSION: sessionNamespace,
    SESSION_REGISTRY: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
  } as Env;
}

describe("extractSessionId", () => {
  it("reads one path segment and rejects a missing id", () => {
    expect(extractSessionId("/api/beliefs/s1")).toBe("s1");
    expect(extractSessionId("/api/beliefs/")).toBeNull();
    expect(extractSessionId("/api/beliefs")).toBeNull();
  });
});

describe("fetchBeliefs", () => {
  it("returns 400 when the path has no session id", async () => {
    const response = await fetchBeliefs(
      new Request("https://worker.example/api/beliefs/"),
      makeEnv(),
      "/api/beliefs/",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "Missing session ID in path" },
    });
  });

  it("returns 502 when the session Durable Object is unreachable", async () => {
    const thrown = await fetchBeliefs(
      new Request("https://worker.example/api/beliefs/s1"),
      makeEnv({ throws: true }),
      "/api/beliefs/s1",
    );
    expect(thrown.status).toBe(502);
    expect(await thrown.json()).toEqual({
      error: { message: "Failed to reach session state: do down" },
    });

    const failed = await fetchBeliefs(
      new Request("https://worker.example/api/beliefs/s1"),
      makeEnv({ status: 500 }),
      "/api/beliefs/s1",
    );
    expect(failed.status).toBe(502);
  });

  it("strips rawText, defaults actions to [], and does not emit ACAO *", async () => {
    const response = await fetchBeliefs(
      new Request("https://worker.example/api/beliefs/s1"),
      makeEnv(),
      "/api/beliefs/s1",
    );
    const body = (await response.json()) as {
      beliefs: { rawText: string }[];
      actions: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.beliefs[0]?.rawText).toBe("");
    expect(body.actions).toEqual([]);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("forwards actions from the session Durable Object", async () => {
    const action = {
      id: "call_1",
      name: "lookup",
      provider: "openai" as const,
      source: "tool_calls" as const,
      argumentFingerprint: "abc",
      argumentFingerprintSource: "canonical" as const,
      argumentBytes: 2,
      sourceClass: "tool_observed" as const,
    };
    const response = await fetchBeliefs(
      new Request("https://worker.example/api/beliefs/s1"),
      makeEnv({
        body: { sessionId: "s1", beliefs: [], actions: [action] },
      }),
      "/api/beliefs/s1",
    );
    const body = (await response.json()) as { actions: unknown[] };
    expect(response.status).toBe(200);
    expect(body.actions).toEqual([action]);
  });

  it("requires read auth when open-read is disabled", async () => {
    const response = await fetchBeliefs(
      new Request("https://worker.example/api/beliefs/s1"),
      makeEnv({ openRead: false, readToken: "secret-token" }),
      "/api/beliefs/s1",
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "Read authentication required" },
    });
  });
});
