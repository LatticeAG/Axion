/**
 * Tests for the pure session-timeline helpers: flattenBeliefBatches and
 * resolveSessionId. These run without any Cloudflare runtime.
 */
import { describe, it, expect } from "vitest";
import { flattenBeliefBatches, resolveSessionId, type BeliefBatch } from "./sessionBeliefs";
import type { ExtractedBelief } from "../lens/types";

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
