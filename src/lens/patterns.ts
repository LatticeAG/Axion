/**
 * Axion Lens - Belief extraction patterns
 *
 * Each pattern is a { pattern, type, confidence, group, evidenceGroup?, actionGroup? }
 * object. The engine walks `BELIEF_PATTERNS` in order; the first pattern that
 * matches a given span wins (so order = precedence).
 *
 * Patterns use case-insensitive matching. Capture group semantics:
 *   - `group`         : the group index (1-based) holding the belief text.
 *   - `evidenceGroup`: optional group index holding cited evidence.
 *   - `actionGroup`  : optional group index holding a stated action.
 *
 * Confidence is a *baseline* for the pattern; per-match confidence is then
 * adjusted up/down by any confidence marker found in the surrounding text.
 */

import type { BeliefType } from './types.js';

export interface BeliefPattern {
  /** Case-insensitive regex (use `i` and `m` flags; no `g` - engine adds it). */
  pattern: RegExp;
  type: BeliefType;
  /** Baseline confidence for matches of this pattern (0–1). */
  confidence: number;
  /** 1-based index of the capture group holding the belief text. */
  group: number;
  /** Optional 1-based index of the capture group holding evidence. */
  evidenceGroup?: number;
  /** Optional 1-based index of the capture group holding an action. */
  actionGroup?: number;
  /** Human label, useful for debugging / dashboard. */
  label: string;
}

/**
 * Ordered list of belief patterns. Order matters: more specific patterns
 * should come before more general ones so they win the first-match race.
 *
 * Conventions:
 *   - Belief text is the *reason/condition*, not the connective.
 *     "because X"  → belief = "X"
 *     "if X then Y" → belief = "X"  (assumption), actionGroup captures "Y"
 *   - Capture groups are kept tight (non-greedy, sentence-bounded) so we
 *     don't bleed across clauses. A clause ends at . ; ! ? or a newline.
 *   - All patterns are written without the `g` flag; `extractBeliefs` adds it.
 */
export const BELIEF_PATTERNS: BeliefPattern[] = [
  // ── Evidence references ────────────────────────────────────────────────
  // Evidence patterns set `evidenceGroup: 1` so the cited text lands in the
  // belief's `evidence` field as well as its `belief` field (both hold the
  // cited text - useful for the dashboard, per BUILD-SPEC §5).
  //
  // "based on X, ..." / "based on the X, ..."
  {
    label: 'based-on',
    type: 'evidence',
    pattern: /\bbased on (?:the )?([^.;!?\n]{2,120}?)(?:[,.;]|\sthen|$)/i,
    group: 1,
    evidenceGroup: 1,
    confidence: 0.8,
  },
  // "according to X, ..."
  {
    label: 'according-to',
    type: 'evidence',
    pattern: /\baccording to (?:the )?([^.;!?\n]{2,120}?)(?:[,.;]|\sthen|$)/i,
    group: 1,
    evidenceGroup: 1,
    confidence: 0.8,
  },
  // "from the X, ..." / "from the X then ..." / "from the X: ..."
  // Requires a following clause signal (comma, "then", or colon) so it reads as
  // evidence introducing a conclusion. This deliberately rejects bare idioms
  // like "from the start" / "from the beginning." that end the clause with no
  // following signal (the top false-positive source for this pattern).
  {
    label: 'from-the',
    type: 'evidence',
    pattern: /\bfrom the ([^.;!?\n]{2,120}?)(?:,\s|\s+then\b|:\s)/i,
    group: 1,
    evidenceGroup: 1,
    confidence: 0.7,
  },
  // "the error says X" / "the error message says X" / "the error indicates X"
  {
    label: 'error-says',
    type: 'evidence',
    pattern: /\bthe error(?: message)? (?:says|indicates|shows|states) "?([^";!?\n]{2,140})"?/i,
    group: 1,
    evidenceGroup: 1,
    confidence: 0.85,
  },
  // "looking at X, ..." - treats the thing being inspected as cited evidence.
  {
    label: 'looking-at',
    type: 'evidence',
    pattern: /\blooking at\s+(?:the\s+)?([^.;!?\n]{2,120}?)(?:[,.;]|\sthen|$)/i,
    group: 1,
    evidenceGroup: 1,
    confidence: 0.75,
  },

  // ── Causal claims ──────────────────────────────────────────────────────
  // "because of X" - split from bare "because" so group 1 always holds the
  // belief text (the previous single pattern used group 2 and never fired for
  // the "because of" branch). See BUILD-SPEC §5.
  {
    label: 'because-of',
    type: 'causal',
    pattern: /\bbecause of\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.85,
  },
  // "because X" / ", because X"  (not "because of", handled above)
  {
    label: 'because',
    type: 'causal',
    pattern: /\bbecause\s+(?!of\b)([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.85,
  },
  // "since X" - but NOT temporal "since [year]"; require a verb-ish word after.
  {
    label: 'since-causal',
    type: 'causal',
    pattern: /\bsince\s+(?!the\s+\d|\d{4})([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.8,
  },
  // "due to X" / "as a result of X"
  {
    label: 'due-to',
    type: 'causal',
    pattern: /\b(?:due to|as a result of)\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.85,
  },
  // "which means X" / "this means X" - the consequence is the causal belief.
  {
    label: 'which-means',
    type: 'causal',
    pattern: /\b(?:which|this) means\s+(?:that\s+)?([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.75,
  },

  // ── Assumptions ─────────────────────────────────────────────────────────
  // "assuming X" / "presumably X"
  {
    label: 'assuming',
    type: 'assumption',
    pattern: /\b(?:assuming|presumably)\s+(?:that\s+)?([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.65,
  },
  // "I'll assume X" / "I will assume X" / "let's assume X"
  {
    label: 'i-assume',
    type: 'assumption',
    pattern: /\b(?:i(?:'ll| will)|let's|let us) assume\s+(?:that\s+)?([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.65,
  },
  // "if X then Y" - captures X as assumption (group 1), Y as action (group 2)
  {
    label: 'if-then',
    type: 'assumption',
    pattern: /\bif\s+([^,.;!?\n]{2,100}?)\s+then\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    actionGroup: 2,
    confidence: 0.6,
  },
  // "given that X" - the premise being taken as given is the assumption.
  {
    label: 'given-that',
    type: 'assumption',
    pattern: /\bgiven that\s+([^.;!?\n]{2,120}?)(?:[,.;!?\n]|$)/i,
    group: 1,
    confidence: 0.65,
  },

  // ── Intentions ──────────────────────────────────────────────────────────
  // "I'll do X" / "I will do X" / "I'm going to X" / "let me X" / "I should X"
  // Capture the action phrase that follows.
  {
    label: 'i-will',
    type: 'intention',
    pattern: /\b(?:i(?:'ll| will|i'm going to|'m going to)|let me|i should|i'm going to)\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.75,
  },
  // "I'm going to refactor the auth module." → covered above.
  // "I plan to X" / "I intend to X"
  {
    label: 'i-plan',
    type: 'intention',
    pattern: /\bi (?:plan|intend)\s+to\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.75,
  },
  // "my plan is to X" - explicit plan statement.
  {
    label: 'my-plan',
    type: 'intention',
    pattern: /\bmy plan is to\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.75,
  },
  // "so that X" - the goal clause is treated as a stated intention.
  {
    label: 'so-that',
    type: 'intention',
    pattern: /\bso that\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]|$)/i,
    group: 1,
    confidence: 0.6,
  },
];

/**
 * Confidence markers. These are scanned in the *surrounding clause* around a
 * match and nudge the baseline confidence up or down by an additive `delta`.
 *
 * The engine sums the deltas of every distinct marker category found near a
 * match, adds them to the pattern baseline, and clamps the result to
 * [0.1, 1.0] (see BUILD-SPEC §5 / README). This replaces the older
 * "interpolate toward a target band" behaviour.
 */
export interface ConfidenceMarkerPattern {
  pattern: RegExp;
  /** Additive nudge applied to the baseline confidence when present. */
  delta: number;
  label: string;
}

export const CONFIDENCE_MARKERS: ConfidenceMarkerPattern[] = [
  { label: 'certain', delta: +0.2, pattern: /\b(?:definitely|certainly|absolutely|without a doubt|guaranteed)\b/i },
  { label: 'likely', delta: +0.1, pattern: /\b(?:probably|likely|most likely|almost certainly|highly likely)\b/i },
  { label: 'possible', delta: -0.2, pattern: /\b(?:might|could be|possibly|may|perhaps)\b/i },
  { label: 'uncertain', delta: -0.3, pattern: /\b(?:not sure|uncertain|unsure|unclear)\b/i },
];

/** Default confidence when no marker is found near a match. */
export const DEFAULT_CONFIDENCE = 0.7;

/** Confidence is clamped to this inclusive range. */
export const CONFIDENCE_MIN = 0.1;
export const CONFIDENCE_MAX = 1.0;

/** Maximum characters of context to scan on each side of a match for markers. */
export const MARKER_SCAN_RADIUS = 80;
