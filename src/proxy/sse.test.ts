import { describe, expect, it } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import { SessionSseHub } from "../state/sse";
import { extractSseSessionId, fetchSessionSse } from "./sse";
import type { Env } from "./types";

function belief(id: string): ExtractedBelief {
  return {
    id,
    sessionId: "run one",
    type: "planning",
    belief: "first I'll inspect the trace",
    confidence: 0.6,
    timestamp: 123,
    rawText: "First I'll inspect the trace.",
    line: 1,
  };
}

function makeEnv(
  handler: (request: Request) => Promise<Response> | Response,
): { env: Env; ids: string[]; requests: Request[] } {
  const ids: string[] = [];
  const requests: Request[] = [];
  const stub = {
    fetch: (input: RequestInfo | URL) => {
      if (!(input instanceof Request)) {
        throw new Error("SSE handler must forward a Request to preserve abort signal");
      }
      requests.push(input);
      return handler(input);
    },
  } as unknown as DurableObjectStub;
  const env = {
    SESSION: {
      idFromName: (name: string) => {
        ids.push(name);
        return name as unknown as DurableObjectId;
      },
      get: () => stub,
    } as unknown as DurableObjectNamespace,
  } as Env;
  return { env, ids, requests };
}

describe("extractSseSessionId", () => {
  it("decodes exactly one path segment", () => {
    expect(extractSseSessionId("/api/sse/run%20one")).toBe("run one");
    expect(extractSseSessionId("/api/sse/a%2Fb")).toBe("a/b");
  });

  it("rejects missing, nested, and malformed ids", () => {
    expect(extractSseSessionId("/api/sse/")).toBeNull();
    expect(extractSseSessionId("/api/sse/run/extra")).toBeNull();
    expect(extractSseSessionId("/api/sse/%E0%A4%A")).toBeNull();
  });
});

describe("fetchSessionSse", () => {
  it("forwards the live stream without buffering and supplies SSE/CORS headers", async () => {
    const hub = new SessionSseHub();
    const fixture = makeEnv((request) => hub.subscribe(request.signal));
    const abort = new AbortController();
    const incoming = new Request("https://worker.example/api/sse/run%20one", {
      signal: abort.signal,
    });

    const response = await fetchSessionSse(incoming, fixture.env, "/api/sse/run%20one");
    const reader = response.body!.getReader();

    expect(fixture.ids).toEqual(["run one"]);
    expect(new URL(fixture.requests[0]!.url).toString()).toBe(
      "https://internal/sse?sessionId=run%20one",
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    hub.publish([belief("live-1")]);
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value!)).toBe(
      `event: new-belief\ndata: ${JSON.stringify(belief("live-1"))}\n\n`,
    );

    abort.abort();
    expect(fixture.requests[0]!.signal.aborted).toBe(true);
    await reader.cancel();
  });

  it("returns a JSON 400 without contacting state for an invalid route", async () => {
    const fixture = makeEnv(() => new Response("unexpected"));
    const response = await fetchSessionSse(
      new Request("https://worker.example/api/sse/"),
      fixture.env,
      "/api/sse/",
    );

    expect(response.status).toBe(400);
    expect(fixture.ids).toEqual([]);
    expect(await response.json()).toEqual({
      error: { message: "Missing session ID in path" },
    });
  });

  it("returns a safe 502 JSON error when the session object cannot be reached", async () => {
    const fixture = makeEnv(() => {
      throw new Error("DO unavailable");
    });
    const response = await fetchSessionSse(
      new Request("https://worker.example/api/sse/run-1"),
      fixture.env,
      "/api/sse/run-1",
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: { message: "Failed to reach session state: DO unavailable" },
    });
  });

  it("does not label a non-success internal response as an SSE stream", async () => {
    const fixture = makeEnv(
      () =>
        new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const response = await fetchSessionSse(
      new Request("https://worker.example/api/sse/missing"),
      fixture.env,
      "/api/sse/missing",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
  });
});
