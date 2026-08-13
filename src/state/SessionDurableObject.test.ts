/**
 * Tests for SessionDurableObject using an in-memory mock of DurableObjectState.
 * Exercises the store → flatten GET round trip and, critically, that GET
 * returns the human-readable sessionName rather than the opaque DO id.
 */
import { describe, it, expect } from "vitest";
import { SessionDurableObject } from "./SessionDurableObject";
import type { ExtractionResult } from "../proxy/types";
import type { ExtractedBelief } from "../lens/types";

function belief(id: string): ExtractedBelief {
  return {
    id,
    sessionId: "ignored",
    type: "causal",
    belief: `belief-${id}`,
    confidence: 0.7,
    timestamp: 0,
    rawText: "",
    line: 1,
  };
}

function makeResult(
  sessionId: string,
  ids: string[],
  overrides: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    sessionId,
    beliefs: ids.map(belief),
    rawText: "raw",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Minimal in-memory DurableObjectState stand-in. */
function makeState(idString = "opaque-do-id-abc123") {
  const store = new Map<string, unknown>();
  return {
    id: { toString: () => idString },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
}

function post(
  session: string,
  ids: string[],
  overrides: Partial<ExtractionResult> = {},
): Request {
  return new Request("https://internal/store-beliefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeResult(session, ids, overrides)),
  });
}

describe("SessionDurableObject", () => {
  it("stores batches and returns a flat chronological list on GET", async () => {
    const doInstance = new SessionDurableObject(makeState());

    await doInstance.fetch(post("my-session", ["a", "b"]));
    await doInstance.fetch(post("my-session", ["c"]));

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { sessionId: string; beliefs: ExtractedBelief[] };

    expect(body.beliefs.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the stored human sessionName, not the DO id", async () => {
    const doInstance = new SessionDurableObject(makeState("opaque-do-id-abc123"));
    await doInstance.fetch(post("human-friendly-name", ["a"]));

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { sessionId: string };

    expect(body.sessionId).toBe("human-friendly-name");
    expect(body.sessionId).not.toBe("opaque-do-id-abc123");
  });

  it("falls back to the request hint before any write", async () => {
    const doInstance = new SessionDurableObject(makeState());

    const res = await doInstance.fetch(
      new Request("https://internal/beliefs?sessionId=hint-name")
    );
    const body = (await res.json()) as { sessionId: string; beliefs: ExtractedBelief[] };

    expect(body.sessionId).toBe("hint-name");
    expect(body.beliefs).toEqual([]);
  });

  it("prefers the stored sessionName over the request hint", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(post("stored-name", ["a"]));

    const res = await doInstance.fetch(
      new Request("https://internal/beliefs?sessionId=hint-name")
    );
    const body = (await res.json()) as { sessionId: string };

    expect(body.sessionId).toBe("stored-name");
  });

  it("decays beliefs from older stored turns while leaving the newest untouched", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(post("age-session", ["old"]));
    await doInstance.fetch(post("age-session", ["new"]));

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { beliefs: ExtractedBelief[] };

    expect(body.beliefs.map((entry) => entry.id)).toEqual(["old", "new"]);
    expect(body.beliefs[0]!.confidence).toBeCloseTo(0.7 * 0.9, 8);
    expect(body.beliefs[1]!.confidence).toBeCloseTo(0.7, 8);
  });

  it("stores per-call usage and returns cumulative usage at /usage", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(
      post("usage-session", ["a"], {
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        modelName: "gpt-test",
        provider: "openai",
        messageCount: 2,
      }),
    );
    await doInstance.fetch(
      post("usage-session", ["b"], {
        usage: { prompt_tokens: 7, completion_tokens: 3 },
        modelName: "claude-test",
        provider: "anthropic",
        messageCount: 3,
      }),
    );

    const usageResponse = await doInstance.fetch(
      new Request("https://internal/usage?sessionId=usage-session"),
    );
    const usage = (await usageResponse.json()) as {
      sessionId: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      calls: number;
    };
    expect(usage).toEqual({
      sessionId: "usage-session",
      usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 },
      calls: 2,
    });
  });

  it("returns a complete export snapshot with raw batches and a decayed timeline", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(
      post("export-session", ["old"], {
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
    );
    await doInstance.fetch(
      post("export-session", ["new"], {
        usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
      }),
    );

    const response = await doInstance.fetch(
      new Request("https://internal/export?sessionId=export-session"),
    );
    const exported = (await response.json()) as {
      sessionId: string;
      beliefs: ExtractedBelief[];
      batches: Array<{ beliefs: ExtractedBelief[]; usage?: { total_tokens?: number } }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      calls: number;
    };

    expect(response.status).toBe(200);
    expect(exported.sessionId).toBe("export-session");
    expect(exported.beliefs.map((entry) => entry.id)).toEqual(["old", "new"]);
    expect(exported.beliefs[0]?.confidence).toBeCloseTo(0.63, 8);
    expect(exported.batches[0]?.beliefs[0]?.confidence).toBeCloseTo(0.7, 8);
    expect(exported.batches.map((batch) => batch.usage?.total_tokens)).toEqual([5, 8]);
    expect(exported.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    expect(exported.calls).toBe(2);
  });

  it("404s on unknown routes", async () => {
    const doInstance = new SessionDurableObject(makeState());
    const res = await doInstance.fetch(new Request("https://internal/nope"));
    expect(res.status).toBe(404);
  });
});
