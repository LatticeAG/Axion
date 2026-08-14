/**
 * Tests for the pure session-timeline helpers: flattenBeliefBatches and
 * resolveSessionId. These run without any Cloudflare runtime.
 */
import { describe, it, expect } from "vitest";
import {
  flattenBatchActions,
  flattenBeliefBatches,
  resolveSessionId,
  type BeliefBatch,
} from "./sessionBeliefs";
import type { ExtractedBelief } from "../lens/types";
import type { ObservedAction } from "../proxy/actions";

function belief(id: string, overrides: Partial<ExtractedBelief> = {}): ExtractedBelief {
  return {
    id,
    sessionId: "s",
    type: "causal",
    belief: `belief-${id}`,
    confidence: 0.7,
    timestamp: 0,
    rawText: "",
    line: 1,
    ...overrides,
  };
}

function batch(ids: string[], timestamp = 0): BeliefBatch {
  return { beliefs: ids.map((id) => belief(id)), rawText: "", timestamp };
}

describe("flattenBeliefBatches", () => {
  it("concatenates every batch's beliefs in storage order", () => {
    const batches = [batch(["a", "b"], 1), batch(["c"], 2), batch(["d", "e"], 3)];
    const flat = flattenBeliefBatches(batches);
    expect(flat.map((b) => b.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("returns an empty array for no batches", () => {
    expect(flattenBeliefBatches([])).toEqual([]);
  });

  it("tolerates malformed batches without throwing", () => {
    const messy = [
      batch(["a"]),
      // deliberately malformed entries
      null as unknown as BeliefBatch,
      { rawText: "x", timestamp: 0 } as unknown as BeliefBatch,
      batch(["b"]),
    ];
    expect(flattenBeliefBatches(messy).map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("returns [] when given a non-array", () => {
    expect(flattenBeliefBatches(undefined as unknown as BeliefBatch[])).toEqual([]);
  });

  it("strips rawText by default and keeps it when includeRawText is true", () => {
    const batches: BeliefBatch[] = [
      {
        beliefs: [belief("a", { rawText: "SECRET MODEL OUTPUT" })],
        rawText: "SECRET MODEL OUTPUT",
        timestamp: 1,
      },
    ];
    expect(flattenBeliefBatches(batches)[0]?.rawText).toBe("");
    expect(flattenBeliefBatches(batches, { includeRawText: true })[0]?.rawText).toBe(
      "SECRET MODEL OUTPUT",
    );
  });

  it("decays confidence while stripping rawText by default", () => {
    const batches: BeliefBatch[] = [
      {
        beliefs: [belief("old", { rawText: "secret", confidence: 0.7 })],
        rawText: "secret",
        timestamp: 1,
      },
      {
        beliefs: [belief("new", { rawText: "secret", confidence: 0.7 })],
        rawText: "secret",
        timestamp: 2,
      },
    ];
    const flat = flattenBeliefBatches(batches, { decayByTurn: true });
    expect(flat[0]?.confidence).toBeCloseTo(0.63, 8);
    expect(flat[0]?.rawText).toBe("");
    expect(flat[1]?.rawText).toBe("");
    expect(flattenBeliefBatches(batches, { decayByTurn: true, includeRawText: true })[0]?.rawText).toBe(
      "secret",
    );
  });
});

describe("flattenBatchActions", () => {
  it("concatenates every batch's actions in storage order", () => {
    const first: ObservedAction = {
      id: "a1",
      name: "lookup",
      provider: "openai",
      source: "tool_calls",
      argumentFingerprint: "aa",
      argumentFingerprintSource: "canonical",
      argumentBytes: 2,
      sourceClass: "tool_observed",
    };
    const second: ObservedAction = {
      ...first,
      id: "a2",
      name: "write",
      provider: "anthropic",
      source: "tool_use",
    };
    const batches: BeliefBatch[] = [
      { ...batch(["x"]), actions: [first] },
      { ...batch(["y"]) },
      { ...batch(["z"]), actions: [second] },
    ];
    expect(flattenBatchActions(batches).map((action) => action.id)).toEqual(["a1", "a2"]);
  });

  it("returns [] for missing or malformed actions without throwing", () => {
    expect(flattenBatchActions([])).toEqual([]);
    expect(flattenBatchActions(undefined as unknown as BeliefBatch[])).toEqual([]);
    expect(
      flattenBatchActions([
        batch(["a"]),
        null as unknown as BeliefBatch,
        { beliefs: [], rawText: "", timestamp: 0, actions: "nope" as unknown as ObservedAction[] },
      ]),
    ).toEqual([]);
  });
});

describe("resolveSessionId", () => {
  it("prefers the stored sessionName over the request hint", () => {
    expect(resolveSessionId("human-name", "hint-name")).toBe("human-name");
  });

  it("falls back to the request hint when no sessionName is stored", () => {
    expect(resolveSessionId(null, "hint-name")).toBe("hint-name");
    expect(resolveSessionId(undefined, "hint-name")).toBe("hint-name");
    expect(resolveSessionId("   ", "hint-name")).toBe("hint-name");
  });

  it("returns empty string when neither is available", () => {
    expect(resolveSessionId(null, null)).toBe("");
    expect(resolveSessionId(undefined, undefined)).toBe("");
  });

  it("trims whitespace from the chosen value", () => {
    expect(resolveSessionId("  human  ", null)).toBe("human");
    expect(resolveSessionId(null, "  hint  ")).toBe("hint");
  });
});
