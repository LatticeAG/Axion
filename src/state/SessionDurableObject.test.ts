/**
 * Tests for SessionDurableObject using an in-memory mock of DurableObjectState.
 * Exercises the store → flatten GET round trip and, critically, that GET
 * returns the human-readable sessionName rather than the opaque DO id.
 */
import { describe, it, expect } from "vitest";
import { SessionDurableObject } from "./SessionDurableObject";
import type { ExtractionResult } from "../proxy/types";
import type { ExtractedBelief } from "../lens/types";
import { createMemoryDurableObjectState } from "./memoryDurableObject";
import type { BeliefBatch } from "./sessionBeliefs";
import type { ObservedAction } from "../proxy/actions";

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

function makeState(idString = "opaque-do-id-abc123", initial: Record<string, unknown> = {}) {
  return createMemoryDurableObjectState(idString, initial);
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

  it("persists inboundMessageCount from the extraction result", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(
      post("inbound-session", ["a"], {
        messageCount: 4,
        inboundMessageCount: 4,
      }),
    );
    await doInstance.fetch(
      post("inbound-session", ["b"], {
        messageCount: 7,
      }),
    );

    const response = await doInstance.fetch(
      new Request("https://internal/export?sessionId=inbound-session"),
    );
    const exported = (await response.json()) as {
      batches: Array<{ messageCount?: number; inboundMessageCount?: number }>;
    };
    expect(exported.batches[0]?.messageCount).toBe(4);
    expect(exported.batches[0]?.inboundMessageCount).toBe(4);
    expect(exported.batches[1]?.messageCount).toBe(7);
    expect(exported.batches[1]?.inboundMessageCount).toBe(7);
  });

  it("persists redactions from the extraction result", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(
      post("redact-session", ["a"], {
        redactions: 3,
      }),
    );

    const response = await doInstance.fetch(
      new Request("https://internal/export?sessionId=redact-session"),
    );
    const exported = (await response.json()) as {
      batches: Array<{ redactions?: number }>;
    };
    expect(exported.batches[0]?.redactions).toBe(3);
  });

  it("persists actions and concatenates them on GET /beliefs", async () => {
    const lookup: ObservedAction = {
      id: "call_1",
      name: "lookup",
      provider: "openai",
      source: "tool_calls",
      argumentFingerprint: "aa",
      argumentFingerprintSource: "canonical",
      argumentBytes: 2,
      sourceClass: "tool_observed",
    };
    const write: ObservedAction = {
      ...lookup,
      id: "toolu_1",
      name: "write",
      provider: "anthropic",
      source: "tool_use",
    };
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(post("tool-session", ["a"], { actions: [lookup] }));
    await doInstance.fetch(post("tool-session", ["b"], { actions: [write] }));

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as {
      sessionId: string;
      beliefs: ExtractedBelief[];
      actions: ObservedAction[];
    };
    expect(body.sessionId).toBe("tool-session");
    expect(body.beliefs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(body.actions.map((action) => action.id)).toEqual(["call_1", "toolu_1"]);
  });

  it("404s on unknown routes", async () => {
    const doInstance = new SessionDurableObject(makeState());
    const res = await doInstance.fetch(new Request("https://internal/nope"));
    expect(res.status).toBe(404);
  });

  it("reads an unmigrated legacy beliefs array and stored sessionName", async () => {
    const legacy: BeliefBatch[] = [
      {
        beliefs: [belief("legacy-a"), belief("legacy-b")],
        rawText: "raw",
        timestamp: 1,
      },
    ];
    const doInstance = new SessionDurableObject(
      makeState("opaque-do-id-abc123", {
        beliefs: legacy,
        sessionName: "legacy-human-name",
      }),
    );

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { sessionId: string; beliefs: ExtractedBelief[] };

    expect(body.sessionId).toBe("legacy-human-name");
    expect(body.beliefs.map((entry) => entry.id)).toEqual(["legacy-a", "legacy-b"]);
  });

  it("migrates a legacy beliefs array on the next write", async () => {
    const doInstance = new SessionDurableObject(
      makeState("opaque-do-id-abc123", {
        beliefs: [
          {
            beliefs: [belief("old")],
            rawText: "raw",
            timestamp: 1,
          },
        ],
        sessionName: "migrated-session",
      }),
    );

    await doInstance.fetch(post("migrated-session", ["new"]));
    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { sessionId: string; beliefs: ExtractedBelief[] };

    expect(body.sessionId).toBe("migrated-session");
    expect(body.beliefs.map((entry) => entry.id)).toEqual(["old", "new"]);
    expect(body.beliefs[0]!.confidence).toBeCloseTo(0.7 * 0.9, 8);
    expect(body.beliefs[1]!.confidence).toBeCloseTo(0.7, 8);
  });

  it("returns callsInSession on store and counts webhook failures on meta", async () => {
    const state = makeState();
    const doInstance = new SessionDurableObject(state);

    const first = (await (
      await doInstance.fetch(post("hook-session", ["a"]))
    ).json()) as { ok: boolean; count: number; callsInSession: number };
    expect(first).toEqual({ ok: true, count: 1, callsInSession: 1 });

    const second = (await (
      await doInstance.fetch(post("hook-session", ["b", "c"]))
    ).json()) as { callsInSession: number; count: number };
    expect(second.callsInSession).toBe(2);
    expect(second.count).toBe(2);

    const bump = await doInstance.fetch(
      new Request("https://internal/webhook-failure", { method: "POST" }),
    );
    expect(bump.status).toBe(200);
    await doInstance.fetch(
      new Request("https://internal/webhook-failure", { method: "POST" }),
    );

    const meta = (await state.storage.get("meta")) as {
      webhookFailures?: number;
      sessionName?: string;
    };
    expect(meta.sessionName).toBe("hook-session");
    expect(meta.webhookFailures).toBe(2);
  });
});
