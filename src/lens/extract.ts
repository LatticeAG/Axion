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
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  decayConfidence,
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
  /** Number of newer session turns since this text was extracted. */
  turnsAgo?: number;
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
  const scored = rawMatches.map((match) => ({
    ...match,
    confidence: adjustConfidence(
      BELIEF_PATTERNS[match.patternIndex]!.confidence,
      surroundingContext(text, match.index, match.fullMatch.length),
    ),
  }));
  const deduped = dedupeOverlaps(scored);

  return deduped.map((m) => {
    const confidence = decayConfidence(m.confidence, opts.turnsAgo);

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
 * Remove duplicate matches, retaining the one with the higher calculated
 * confidence per span. Source position and pattern order provide
 * deterministic tie-breakers.
 *
 * Containment is belief-preserving (issue #3): a kept match only suppresses a
 * later candidate it STRICTLY contains. A candidate whose span encloses or
 * exactly matches the kept span is the enclosing belief (e.g. an assumption
 * clause wrapping a trailing "I'll proceed" intention) or the
 * duplicate-correct replacement, so it is kept and strictly-contained
 * followers still collapse against it. Crossing/partial overlaps keep the
 * pre-existing first-come (confidence-ranked) wins semantics.
 */
/**
 * Marker families whose outer-vs-inner containment describes ONE event
 * claimed by sibling markers (partial-overlap semantics), not two distinct
 * beliefs. "But actually, X" fires BOTH the broader contradiction transition
 * and the inner self-correction "actually, X" over the same clause - the
 * higher-confidence self-correction must keep the whole claim, the enclosing
 * contradiction is not a second belief. Enclosing-belief protection (issue
 * #3) only applies OUTSIDE these families: an assumption wrapping a trailing
 * intention, or a causal clause feeding an "I believe" intention, are two
 * genuinely distinct beliefs and both must survive.
 */
const QUALIFICATION_FAMILY: ReadonlySet<BeliefType> = new Set([
  'contradiction',
  'self-correction',
]);
const sameQualificationFamily = (a: BeliefType, b: BeliefType): boolean =>
  QUALIFICATION_FAMILY.has(a) && QUALIFICATION_FAMILY.has(b);

function dedupeOverlaps<T extends PatternMatch & { confidence: number }>(matches: T[]): T[] {
  const ranked = [...matches].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.index - b.index ||
      a.patternIndex - b.patternIndex,
  );
  const kept: T[] = [];

  for (const candidate of ranked) {
    const candidateEnd = candidate.index + candidate.fullMatch.length;
    // A kept match suppresses an overlapping candidate, with one exception
    // (issue #3): a candidate that ENCLOSES the kept match - starts strictly
    // before it and ends at or after it - is an enclosing belief (e.g. an
    // assumption clause wrapping a trailing "I'll proceed" intention), so
    // BOTH survive. Identical spans and same-start containment (two markers
    // claiming the same anchored text, e.g. "I will assume X": the inner,
    // higher-confidence match wins and the outer collapses into it), and
    // crossing/partial overlaps, all keep the pre-existing suppression
    // semantics.
    const dropped = kept.some((existing) => {
      const existingEnd = existing.index + existing.fullMatch.length;
      const intersects = candidate.index < existingEnd && existing.index < candidateEnd;
      if (!intersects) return false;
      const candidateEncloses =
        candidate.index < existing.index && candidateEnd >= existingEnd;
      if (!candidateEncloses) return true;
      // Enclosing protection only keeps genuinely DIFFERENT beliefs. Sibling
      // markers for one qualification event still collapse (partial-overlap
      // semantics preserved).
      return sameQualificationFamily(candidate.type, existing.type);
    });
    if (!dropped) kept.push(candidate);
  }

  return kept.sort((a, b) => a.index - b.index || a.patternIndex - b.patternIndex);
}

/** Extract a window of ±MARKER_SCAN_RADIUS chars around a match for marker scan. */
function surroundingContext(text: string, start: number, length: number): string {
  const lo = Math.max(0, start - MARKER_SCAN_RADIUS);
  const hi = Math.min(text.length, start + length + MARKER_SCAN_RADIUS);
  return text.slice(lo, hi);
}

/**
 * Adjust a pattern's baseline confidence by summing the additive `delta` of
 * every distinct confidence-marker category found in the surrounding context,
 * then clamping to [CONFIDENCE_MIN, CONFIDENCE_MAX].
 */
function adjustConfidence(baseline: number, context: string): number {
  let confidence = baseline;
  for (const marker of CONFIDENCE_MARKERS) {
    if (marker.pattern.test(context)) {
      confidence += marker.delta;
    }
  }
  return clampConfidence(confidence);
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

function clampConfidence(n: number): number {
  if (Number.isNaN(n)) return CONFIDENCE_MIN;
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, n));
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
