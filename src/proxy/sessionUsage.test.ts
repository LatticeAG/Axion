import { describe, expect, it } from "vitest";
import { extractSessionUsageId, fetchSessionUsage } from "./sessionUsage";
import type { Env } from "./types";

function makeEnv(fetchImpl: (input: RequestInfo | URL) => Promise<Response>): Env {
  return {
    SESSION: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({ fetch: fetchImpl }) as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

describe("extractSessionUsageId", () => {
  it("decodes a valid nested session usage path", () => {
    expect(extractSessionUsageId("/api/sessions/a%20session/usage")).toBe("a session");
  });

  it("rejects malformed, missing, and extra path segments", () => {
    expect(extractSessionUsageId("/api/sessions//usage")).toBeNull();
    expect(extractSessionUsageId("/api/sessions/a/usage/extra")).toBeNull();
    expect(extractSessionUsageId("/api/sessions/%E0%A4%A/usage")).toBeNull();
  });
});

describe("fetchSessionUsage", () => {
  it("forwards to the SessionDO /usage route and preserves its JSON body", async () => {
    let target = "";
    const response = await fetchSessionUsage(
      makeEnv(async (input) => {
        target = String(input);
        return new Response(
          JSON.stringify({
            sessionId: "run-1",
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            calls: 1,
          }),
        );
      }),
      "/api/sessions/run-1/usage",
    );
    expect(target).toBe("https://internal/usage?sessionId=run-1");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toMatchObject({
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });

  it("returns a 502 when the SessionDO is unavailable", async () => {
    const response = await fetchSessionUsage(
      makeEnv(async () => {
        throw new Error("offline");
      }),
      "/api/sessions/run-1/usage",
    );
    expect(response.status).toBe(502);
  });
});
