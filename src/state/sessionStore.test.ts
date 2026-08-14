import { describe, expect, it, vi } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import type { BeliefBatch } from "./sessionBeliefs";
import { MAX_BATCH_RAW_CHARS, MAX_BELIEF_BATCHES } from "./sessionBeliefs";
import {
  batchKey,
  batchesFromList,
  clampMaxBeliefBatches,
  emptySessionMeta,
  incrementWebhookFailures,
  migrateLegacyBatches,
  planAppendBatch,
  prepareBeliefBatch,
} from "./sessionStore";

function batch(id: string, rawText = `raw-${id}`): BeliefBatch {
  return {
    beliefs: [],
    rawText,
    timestamp: 1,
  };
}

function hugeBelief(text: string): ExtractedBelief {
  return {
    id: "h",
    sessionId: "s",
    type: "causal",
    belief: text,
    confidence: 0.7,
    timestamp: 1,
    rawText: "",
    line: 1,
  };
}

describe("sessionStore keys and caps", () => {
  it("zero-pads batch keys so 10 sorts after 2", () => {
    const keys = [batchKey(2), batchKey(10), batchKey(0)].sort();
    expect(keys).toEqual(["batch:000000", "batch:000002", "batch:000010"]);
  });

  it("clamps AXION_MAX_BELIEF_BATCHES to [20, 1000]", () => {
    expect(clampMaxBeliefBatches(undefined)).toBe(MAX_BELIEF_BATCHES);
    expect(clampMaxBeliefBatches("3")).toBe(20);
    expect(clampMaxBeliefBatches("5000")).toBe(1000);
    expect(clampMaxBeliefBatches("80")).toBe(80);
  });
});

describe("prepareBeliefBatch", () => {
  it("truncates oversize rawText to MAX_BATCH_RAW_CHARS", () => {
    const prepared = prepareBeliefBatch(batch("x", "a".repeat(MAX_BATCH_RAW_CHARS + 50)));
    expect(prepared.truncated).toBe(true);
    expect(prepared.droppedRawText).toBe(false);
    expect(prepared.batch.rawText.length).toBe(MAX_BATCH_RAW_CHARS);
  });

  it("drops rawText when the encoded batch still exceeds 100 KiB", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepared = prepareBeliefBatch({
      beliefs: [hugeBelief("x".repeat(110_000))],
      rawText: "keep-me",
      timestamp: 1,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    spy.mockRestore();
    expect(prepared.truncated).toBe(true);
    expect(prepared.droppedRawText).toBe(true);
    expect(prepared.batch.rawText).toBe("");
    expect(prepared.batch.beliefs[0]?.belief.length).toBe(110_000);
    expect(prepared.batch.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    });
  });

  it("logs axion: telemetry_truncated when dropping oversize rawText", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    prepareBeliefBatch({
      beliefs: [hugeBelief("x".repeat(110_000))],
      rawText: "keep-me",
      timestamp: 1,
    });
    expect(spy).toHaveBeenCalledWith("axion: telemetry_truncated");
    spy.mockRestore();
  });
});

describe("legacy migration and cap", () => {
  it("migrates a 3-batch legacy array onto padded keys", () => {
    const legacy = [batch("a"), batch("b"), batch("c")];
    const migrated = migrateLegacyBatches(legacy, "sess");
    expect(migrated.meta).toEqual({
      sessionName: "sess",
      batchCount: 3,
      firstIndex: 0,
      schemaVersion: 2,
    });
    expect(Object.keys(migrated.entries).sort()).toEqual([
      "batch:000000",
      "batch:000001",
      "batch:000002",
    ]);
    expect(migrated.entries["batch:000001"]?.rawText).toBe("raw-b");
  });

  it("201st write drops batch 0 and does not keep its key", () => {
    let meta = emptySessionMeta("sess");
    const listed = new Map<string, BeliefBatch>();
    for (let i = 0; i < MAX_BELIEF_BATCHES + 1; i++) {
      const plan = planAppendBatch(meta, batch(String(i)));
      if (plan.deleteKey) listed.delete(plan.deleteKey);
      listed.set(plan.putKey, plan.putValue);
      meta = plan.meta;
    }
    expect(meta.batchCount).toBe(MAX_BELIEF_BATCHES);
    expect(meta.firstIndex).toBe(1);
    expect(listed.has("batch:000000")).toBe(false);
    const ordered = batchesFromList(meta, listed);
    expect(ordered).toHaveLength(MAX_BELIEF_BATCHES);
    expect(ordered[0]?.rawText).toBe("raw-1");
    expect(ordered.at(-1)?.rawText).toBe(`raw-${MAX_BELIEF_BATCHES}`);
  });

  it("increments webhookFailures from unset or existing counts", () => {
    expect(incrementWebhookFailures(emptySessionMeta("s")).webhookFailures).toBe(1);
    const next = incrementWebhookFailures({
      ...emptySessionMeta("s"),
      webhookFailures: 3,
    });
    expect(next.webhookFailures).toBe(4);
  });
});
