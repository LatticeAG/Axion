/**
 * Axion Lens - Session belief timeline helpers.
 *
 * Phase 1 stores beliefs as an append-only list of batches (one batch per
 * extracted response). The public API exposes a single flat chronological
 * list, so these pure helpers do the flattening and sessionId resolution
 * without any Cloudflare runtime dependency, which keeps them unit-testable.
 */

import type { ExtractedBelief } from "../lens/types.js";
import { decayConfidence } from "../lens/patterns.js";
import { sumTokenUsage, type CumulativeTokenUsage, type TokenUsage } from "./sessionUsage.js";

/** One stored batch: the beliefs extracted from a single response. */
export interface BeliefBatch {
  beliefs: ExtractedBelief[];
  rawText: string;
  timestamp: number;
  /** Upstream token counts for this individual model call, if provided. */
  usage?: TokenUsage;
  /** Session-registry metadata captured alongside the call. */
  modelName?: string;
  provider?: "openai" | "anthropic";
  messageCount?: number;
}

/** Options governing how stored batch beliefs are exposed to readers. */
export interface FlattenBeliefBatchesOptions {
  /** Decay each batch by the number of newer stored turns. */
  decayByTurn?: boolean;
}

/**
 * Concatenate every batch's `beliefs` array in storage order, producing the
 * flat chronological timeline the public API returns. Tolerant of malformed
 * input (non-array batches / missing `beliefs`) so a corrupt storage read can
 * never throw.
 */
export function flattenBeliefBatches(
  batches: BeliefBatch[],
  options: FlattenBeliefBatchesOptions = {},
): ExtractedBelief[] {
  if (!Array.isArray(batches)) return [];
  const out: ExtractedBelief[] = [];
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    if (batch && Array.isArray(batch.beliefs)) {
      if (!options.decayByTurn) {
        out.push(...batch.beliefs);
        continue;
      }
      const turnsAgo = batches.length - 1 - index;
      for (const belief of batch.beliefs) {
        out.push({
          ...belief,
          confidence: decayConfidence(belief.confidence, turnsAgo),
        });
      }
    }
  }
  return out;
}

/** Aggregate all per-call usage counters in chronological storage order. */
export function aggregateBatchUsage(batches: BeliefBatch[]): CumulativeTokenUsage {
  if (!Array.isArray(batches)) return sumTokenUsage([]);
  return sumTokenUsage(
    batches.map((batch) => (batch && typeof batch === "object" ? batch.usage : undefined)),
  );
}

/**
 * Resolve the human-readable sessionId for a GET response.
 *
 * Preference: the stored `sessionName` (the human name the caller used, saved
 * on the first write) wins. If nothing has been stored yet, fall back to the
 * request hint (the id from the incoming path). Never return the opaque
 * Durable Object id.
 */
export function resolveSessionId(
  storedName?: string | null,
  hint?: string | null
): string {
  const stored = storedName?.trim();
  if (stored) return stored;
  const hinted = hint?.trim();
  if (hinted) return hinted;
  return "";
}
