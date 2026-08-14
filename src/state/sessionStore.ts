/**
 * Sharded per-session belief timeline storage helpers.
 *
 * Classic Durable Object KV values are capped at 128 KiB. One JSON array of
 * every BeliefBatch plus rawText blows that limit. Layout:
 *
 *   meta            { sessionName, batchCount, firstIndex, schemaVersion: 2 }
 *   batch:NNNNNN    one BeliefBatch, zero-padded for string-sort order
 *
 * Writes are append-only. When the cap is exceeded, firstIndex advances and
 * the oldest padded key is deleted. Legacy `"beliefs"` arrays migrate on the
 * next write inside one storage transaction.
 */

import type { BeliefBatch } from "./sessionBeliefs";
import {
  MAX_BATCH_RAW_CHARS,
  MAX_BELIEF_BATCHES,
} from "./sessionBeliefs";

export const SESSION_SCHEMA_VERSION = 2;
export const LEGACY_BELIEFS_KEY = "beliefs";
export const LEGACY_SESSION_NAME_KEY = "sessionName";
export const SESSION_META_KEY = "meta";
export const OVERSIZE_BATCH_BYTES = 100 * 1024;

/** Inclusive start / exclusive end for a chronological ranged list of batches. */
export const BATCH_LIST_RANGE = { start: "batch:", end: "batch;" } as const;

export interface SessionMeta {
  sessionName: string;
  batchCount: number;
  firstIndex: number;
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  webhookFailures?: number;
}

export interface PreparedBeliefBatch {
  batch: BeliefBatch;
  truncated: boolean;
  droppedRawText: boolean;
}

/** Zero-padded batch key so ranged list stays chronological. */
export function batchKey(index: number): string {
  return `batch:${String(index).padStart(6, "0")}`;
}

/** Clamp AXION_MAX_BELIEF_BATCHES to [20, 1000], default 200. */
export function clampMaxBeliefBatches(raw?: string): number {
  if (raw === undefined || raw.trim() === "") return MAX_BELIEF_BATCHES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MAX_BELIEF_BATCHES;
  return Math.max(20, Math.min(1000, Math.floor(parsed)));
}

export function incrementWebhookFailures(meta: SessionMeta): SessionMeta {
  const current = meta.webhookFailures;
  const n =
    typeof current === "number" && Number.isFinite(current)
      ? Math.max(0, Math.trunc(current))
      : 0;
  return { ...meta, webhookFailures: n + 1 };
}

export function emptySessionMeta(sessionName = ""): SessionMeta {
  return {
    sessionName,
    batchCount: 0,
    firstIndex: 0,
    schemaVersion: SESSION_SCHEMA_VERSION,
  };
}

export function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionName === "string" &&
    typeof record.batchCount === "number" &&
    Number.isFinite(record.batchCount) &&
    typeof record.firstIndex === "number" &&
    Number.isFinite(record.firstIndex) &&
    record.schemaVersion === SESSION_SCHEMA_VERSION
  );
}

/** Truncate rawText to the inspect-window cap; drop it if the batch is still huge. */
export function prepareBeliefBatch(batch: BeliefBatch): PreparedBeliefBatch {
  let next: BeliefBatch = { ...batch };
  let truncated = false;
  let droppedRawText = false;
  if (typeof next.rawText === "string" && next.rawText.length > MAX_BATCH_RAW_CHARS) {
    next = { ...next, rawText: next.rawText.slice(0, MAX_BATCH_RAW_CHARS) };
    truncated = true;
  }
  const encoded = new TextEncoder().encode(JSON.stringify(next));
  if (encoded.byteLength > OVERSIZE_BATCH_BYTES) {
    next = { ...next, rawText: "" };
    truncated = true;
    droppedRawText = true;
    console.error("axion: telemetry_truncated");
  }
  return { batch: next, truncated, droppedRawText };
}

export function migrateLegacyBatches(
  legacy: BeliefBatch[],
  sessionName: string,
): { meta: SessionMeta; entries: Record<string, BeliefBatch> } {
  const entries: Record<string, BeliefBatch> = {};
  const batches = Array.isArray(legacy) ? legacy : [];
  for (let index = 0; index < batches.length; index++) {
    entries[batchKey(index)] = batches[index]!;
  }
  return {
    meta: {
      sessionName,
      batchCount: batches.length,
      firstIndex: 0,
      schemaVersion: SESSION_SCHEMA_VERSION,
    },
    entries,
  };
}

/**
 * Plan an append against already-loaded meta (after any legacy migration).
 * Indices stay append-only: we never rewrite earlier batch keys.
 */
export function planAppendBatch(
  meta: SessionMeta,
  batch: BeliefBatch,
  maxBatches: number = MAX_BELIEF_BATCHES,
): { meta: SessionMeta; putKey: string; putValue: BeliefBatch; deleteKey?: string } {
  const cap = Math.max(1, maxBatches);
  const writeIndex = meta.firstIndex + meta.batchCount;
  let firstIndex = meta.firstIndex;
  let batchCount = meta.batchCount + 1;
  let deleteKey: string | undefined;
  if (batchCount > cap) {
    deleteKey = batchKey(firstIndex);
    firstIndex += 1;
    batchCount -= 1;
  }
  return {
    meta: {
      ...meta,
      firstIndex,
      batchCount,
      schemaVersion: SESSION_SCHEMA_VERSION,
    },
    putKey: batchKey(writeIndex),
    putValue: batch,
    deleteKey,
  };
}

function isStoredBatch(value: unknown): value is BeliefBatch {
  return !!value && typeof value === "object" && !Array.isArray(value) && "beliefs" in value;
}

/** Order a ranged list of batch:* values using meta.firstIndex / batchCount. */
export function batchesFromList(
  meta: SessionMeta,
  listed: Map<string, unknown> | Record<string, unknown>,
): BeliefBatch[] {
  const lookup = listed instanceof Map ? listed : new Map(Object.entries(listed));
  const batches: BeliefBatch[] = [];
  for (let offset = 0; offset < meta.batchCount; offset++) {
    const key = batchKey(meta.firstIndex + offset);
    const batch = lookup.get(key);
    if (isStoredBatch(batch)) batches.push(batch);
  }
  return batches;
}
