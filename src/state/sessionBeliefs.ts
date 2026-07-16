/**
 * Axion Lens - Session belief timeline helpers.
 *
 * Phase 1 stores beliefs as an append-only list of batches (one batch per
 * extracted response). The public API exposes a single flat chronological
 * list, so these pure helpers do the flattening and sessionId resolution
 * without any Cloudflare runtime dependency, which keeps them unit-testable.
 */

import type { ExtractedBelief } from "../lens/types.js";

/** One stored batch: the beliefs extracted from a single response. */
export interface BeliefBatch {
  beliefs: ExtractedBelief[];
  rawText: string;
  timestamp: number;
}

/**
 * Concatenate every batch's `beliefs` array in storage order, producing the
 * flat chronological timeline the public API returns. Tolerant of malformed
 * input (non-array batches / missing `beliefs`) so a corrupt storage read can
 * never throw.
 */
export function flattenBeliefBatches(batches: BeliefBatch[]): ExtractedBelief[] {
  if (!Array.isArray(batches)) return [];
  const out: ExtractedBelief[] = [];
  for (const batch of batches) {
    if (batch && Array.isArray(batch.beliefs)) {
      out.push(...batch.beliefs);
    }
  }
  return out;
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
