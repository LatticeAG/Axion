import { describe, expect, it } from "vitest";
import { extractSessionTurnsId, fetchSessionTurns } from "./sessionTurns";
import type { Env } from "./types";

function makeEnv(fetchImpl: (input: RequestInfo | URL) => Promise<Response>): Env {
  return {
    AXION_OPEN_READ: "true",
    SESSION: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({ fetch: fetchImpl }) as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

function turnsRequest(): Request {
  return new Request("https://worker.example/api/sessions/run-1/turns");
}

describe("extractSessionTurnsId", () => {
  it("decodes a valid nested session turns path", () => {
    expect(extractSessionTurnsId("/api/sessions/a%20session/turns")).toBe("a session");
  });

  it("rejects malformed, missing, and extra path segments", () => {
    expect(extractSessionTurnsId("/api/sessions//turns")).toBeNull();
    expect(extractSessionTurnsId("/api/sessions/a/turns/extra")).toBeNull();
    expect(extractSessionTurnsId("/api/sessions/%E0%A4%A/turns")).toBeNull();
  });
});

describe("fetchSessionTurns", () => {
  it("forwards to the SessionDO /turns route and preserves its JSON body", async () => {
    let target = "";
    const response = await fetchSessionTurns(
      turnsRequest(),
      makeEnv(async (input) => {
        target = String(input);
        return new Response(
          JSON.stringify({
            sessionId: "run-1",
            calls: 1,
            turns: [{ beliefs: [], rawText: "", timestamp: 1 }],
          }),
        );
      }),
      "/api/sessions/run-1/turns",
    );
    expect(target).toBe("https://internal/turns?sessionId=run-1");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      sessionId: "run-1",
      calls: 1,
      turns: [{ beliefs: [], rawText: "", timestamp: 1 }],
    });
  });

  it("returns a 502 when the SessionDO is unavailable", async () => {
    const response = await fetchSessionTurns(
      turnsRequest(),
      makeEnv(async () => {
        throw new Error("offline");
      }),
      "/api/sessions/run-1/turns",
    );
    expect(response.status).toBe(502);
  });
});
