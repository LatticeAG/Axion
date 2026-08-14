import { describe, expect, it } from "vitest";
import { runExtraction } from "./extraction";
import type { Env, ExtractionResult } from "./types";

function makeEnv(received: ExtractionResult[]): Env {
  const stub = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      received.push(JSON.parse(String(init?.body)) as ExtractionResult);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  } as unknown as DurableObjectStub;

  return {
    SESSION: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => stub,
    },
  } as unknown as Env;
}

describe("runExtraction", () => {
  it("persists model metadata and canonical per-call usage with beliefs", async () => {
    const received: ExtractionResult[] = [];
    const stored = await runExtraction(
      makeEnv(received),
      "session-usage",
      "I will inspect the logs.",
      {
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        modelName: "gpt-test",
        provider: "openai",
        waitUntil: (promise) => {
          void promise;
        },
      },
    );
    expect(stored).toEqual({ stored: true });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      sessionId: "session-usage",
      modelName: "gpt-test",
      provider: "openai",
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
    expect(received[0]).not.toHaveProperty("waitUntil");
    expect(received[0]!.beliefs).toHaveLength(1);
  });

  it("redacts secrets before the Durable Object store", async () => {
    const received: ExtractionResult[] = [];
    await runExtraction(
      makeEnv(received),
      "secret-session",
      "Because sk-ant-api03-TEST failed the request.",
    );

    expect(received).toHaveLength(1);
    const body = JSON.stringify(received[0]);
    expect(body).not.toContain("sk-ant-api03-TEST");
    expect(received[0]?.redactions).toBeGreaterThan(0);
    expect(received[0]?.rawText).toContain("[REDACTED:anthropic_key]");
  });

  it("still persists an empty belief batch when a call only has usage", async () => {
    const received: ExtractionResult[] = [];
    await runExtraction(makeEnv(received), "usage-only", "", {
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      provider: "anthropic",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      sessionId: "usage-only",
      beliefs: [],
      rawText: "",
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    expect(received[0]!.actions).toEqual([]);
  });
});
