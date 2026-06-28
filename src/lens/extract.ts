/**
 * Axion Lens - Belief extraction engine.
 *
 * Rule-based extractor: walks the ordered `BELIEF_PATTERNS` list against a
 * model response, deduplicates overlapping matches (first pattern wins per
 * span), then shapes each into an `ExtractedBelief` with confidence adjusted
 * by nearby `CONFIDENCE_MARKERS`.
 *
 * Public contract:
 *   export async function extractBeliefs(text, opts?): Promise<ExtractedBelief[]>
 */

import type { BeliefType, ExtractedBelief, PatternMatch } from './types.js';
import {
  BELIEF_PATTERNS,
  CONFIDENCE_MARKERS,
  DEFAULT_CONFIDENCE,
  MARKER_SCAN_RADIUS,
} from './patterns.js';

/** Options for {@link extractBeliefs}. */
export interface ExtractBeliefsOptions {
  /** Session ID to stamp onto every belief. Defaults to a generated UUID. */
  sessionId?: string;
  /** Inject a custom UUID generator (defaults to crypto.randomUUID). */
  uuid?: () => string;
  /** Inject a custom clock (defaults to Date.now). */
  now?: () => number;
}

/**
 * Extract beliefs from a model response.
 *
 * @param text   The raw model response text.
 * @param opts   Optional sessionId / uuid / now overrides.
 * @returns      Array of {@link ExtractedBelief}, in source order.
 */
export async function extractBeliefs(
  text: string,
  opts: ExtractBeliefsOptions = {},
): Promise<ExtractedBelief[]> {
  if (!text || !text.trim()) return [];

  const sessionId = opts.sessionId ?? randomSessionId();
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => Date.now());
  const timestamp = now();

  const rawMatches = scanPatterns(text);
  const deduped = dedupeOverlaps(rawMatches);

  return deduped.map((m) => {
    const baseline = BELIEF_PATTERNS[m.patternIndex]!.confidence;
    const context = surroundingContext(text, m.index, m.fullMatch.length);
    const confidence = adjustConfidence(baseline, context);

    const belief = m.capture.trim();
    const evidence = m.evidence?.trim() || undefined;
    const actionTaken = m.action?.trim() || undefined;

    return {
      id: uuid(),
      sessionId,
      type: m.type,
      belief,
      evidence,
      confidence,
      actionTaken,
      timestamp,
      rawText: m.fullMatch.trim(),
      line: m.line,
    } satisfies ExtractedBelief;
  });
}

export { extractBeliefs as default };

/** Re-export so `import { DEFAULT_CONFIDENCE } from './extract.js'` works. */
export { DEFAULT_CONFIDENCE };

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Walk every pattern in `BELIEF_PATTERNS` and collect all matches.
 * Each pattern's `group`/`evidenceGroup`/`actionGroup` are resolved here.
 */
function scanPatterns(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (let pi = 0; pi < BELIEF_PATTERNS.length; pi++) {
    const p = BELIEF_PATTERNS[pi]!;
    const re = withGlobalFlag(p.pattern);
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      const capture = (p.group != null ? m[p.group] : m[0]) ?? '';
      if (!capture.trim()) continue; // skip empty captures

      const evidence = p.evidenceGroup != null ? m[p.evidenceGroup] : undefined;
      const action = p.actionGroup != null ? m[p.actionGroup] : undefined;

      matches.push({
        patternIndex: pi,
        type: p.type,
        capture,
        fullMatch: m[0],
        index: m.index,
        line: lineNumberAt(text, m.index),
        evidence: evidence?.trim() || undefined,
        action: action?.trim() || undefined,
      });
    }
  }

  // Stable order by source position, then pattern precedence.
  matches.sort((a, b) => a.index - b.index || a.patternIndex - b.patternIndex);
  return matches;
}

/**
 * Remove matches whose span is wholly contained within an earlier (by start,
 * then pattern precedence) match's span. This implements the documented
 * "first pattern wins per span" rule: once a region is claimed, nested
 * sub-matches from later patterns are dropped.
 */
function dedupeOverlaps(matches: PatternMatch[]): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const m of matches) {
    const mEnd = m.index + m.fullMatch.length;
    const dominated = out.some((kept) => {
      const kEnd = kept.index + kept.fullMatch.length;
      return m.index >= kept.index && mEnd <= kEnd;
    });
    if (!dominated) out.push(m);
  }
  return out;
}

/** Extract a window of ±MARKER_SCAN_RADIUS chars around a match for marker scan. */
function surroundingContext(text: string, start: number, length: number): string {
  const lo = Math.max(0, start - MARKER_SCAN_RADIUS);
  const hi = Math.min(text.length, start + length + MARKER_SCAN_RADIUS);
  return text.slice(lo, hi);
}

/**
 * Adjust a pattern's baseline confidence toward the strongest marker band
 * found in the surrounding context. The strongest marker (first in
 * `CONFIDENCE_MARKERS`, which is ordered by descending strength) wins.
 */
function adjustConfidence(baseline: number, context: string): number {
  for (const marker of CONFIDENCE_MARKERS) {
    if (marker.pattern.test(context)) {
      // Interpolate baseline halfway toward the marker's target band.
      return clamp01((baseline + marker.confidence) / 2);
    }
  }
  return clamp01(baseline);
}

/** Return the `pattern` with the `g` flag added (idempotent). */
function withGlobalFlag(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  return new RegExp(pattern.source, flags);
}

/** 1-indexed line number of a character offset in `text`. */
function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Fallback session id when none is supplied. */
function randomSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Type re-exports for convenience within this module's own type-checking.
export type { BeliefType, ExtractedBelief };
