/**
 * Axion Lens - Belief extraction patterns
 *
 * Each pattern is a { pattern, type, confidence, group, evidenceGroup?, actionGroup? }
 * object. The engine scores every candidate and keeps the highest-confidence
 * match for an overlapping span. Order is a deterministic tie-breaker only.
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

/**
 * Clause body shared by every bounded capture.
 *
 * A '.' only terminates a clause when followed by whitespace or
 * end-of-input, so dots inside paths/URLs ("/etc/app/config.yaml",
 * "https://example.com/x.y", "config.yaml") do NOT split a clause.
 * ';', '!', '?' and newlines always terminate a clause.
 */
const CLAUSE_BODY = String.raw`(?:[^.;!?\n]|\.(?!\s|$))`;

/**
 * Matching clause terminator: ';', '!', '?', a newline, end-of-input, or a
 * '.' that is followed by whitespace/end-of-input (a real sentence end).
 */
const CLAUSE_END = String.raw`(?:[;!?\n]|\.(?=\s|$)|$)`;

/**
 * Build a case-insensitive clause-bounded pattern from a string source that
 * interpolates {@link CLAUSE_BODY} for its belief-text captures. All captures
 * stay non-greedy and length-bounded exactly like the hand-written literals
 * they replace; `extractBeliefs` adds the `g` flag at scan time.
 */
function clausePattern(source: string): RegExp {
  return new RegExp(source, 'i');
}

/**
 * The fixed confidence baseline for each reasoning-fragment type.
 *
 * Keeping this table separate from the individual regular expressions makes
 * confidence semantics consistent even when a type gains more phrases.
 */
export const BELIEF_TYPE_CONFIDENCE_BASELINES = {
  causal: 0.7,
  assumption: 0.5,
  intention: 0.8,
  evidence: 0.6,
  uncertainty: 0.3,
  contradiction: 0.4,
  planning: 0.6,
  'self-correction': 0.5,
} as const satisfies Record<BeliefType, number>;

/** UI-ready visual metadata for the dashboard and API consumers. */
export interface BeliefTypeVisual {
  /** Human-readable type label. */
  label: string;
  /** Accessible, high-contrast color for dark dashboard surfaces. */
  color: string;
  /** Compact Unicode icon suitable for a type pill. */
  icon: string;
}

/**
 * A single visual vocabulary shared by all eight belief types. The dashboard
 * is deliberately free to use these values directly or map them to CSS vars.
 */
export const BELIEF_TYPE_VISUALS = {
  causal: { label: 'Causal', color: '#ff9f43', icon: '↗' },
  assumption: { label: 'Assumption', color: '#b68cff', icon: '◇' },
  intention: { label: 'Intention', color: '#00d4ff', icon: '→' },
  evidence: { label: 'Evidence', color: '#47d7a3', icon: '▣' },
  uncertainty: { label: 'Uncertainty', color: '#f6c85f', icon: '?' },
  contradiction: { label: 'Contradiction', color: '#ff668a', icon: '⇄' },
  planning: { label: 'Planning', color: '#78a9ff', icon: '☷' },
  'self-correction': { label: 'Self-correction', color: '#d6a8ff', icon: '↺' },
} as const satisfies Record<BeliefType, BeliefTypeVisual>;

export interface BeliefPattern {
  /** Case-insensitive regex (no `g` flag - the engine adds it). */
  pattern: RegExp;
  type: BeliefType;
  /** Type baseline, duplicated here for easy pattern inspection (0–1). */
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
 * Ordered list of belief patterns. Order only resolves equal-confidence
 * overlaps; otherwise the higher-confidence type is retained.
 *
 * Conventions:
 *   - Belief text is the *reason/condition*, not the connective.
 *     "because X"  → belief = "X"
 *     "if X then Y" → belief = "X"  (assumption), actionGroup captures "Y"
 *   - Capture groups are kept tight (non-greedy, sentence-bounded) so we
 *     don't bleed across clauses. A clause ends at ; ! ? a newline, or a
 *     '.' that is followed by whitespace/end-of-input - see CLAUSE_BODY.
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
    pattern: clausePattern(String.raw`\bbased on (?:the )?(${CLAUSE_BODY}{2,120}?)(?:[,.;]|\sthen|$)`),
    group: 1,
    evidenceGroup: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.evidence,
  },
  // "according to X, ..."
  {
    label: 'according-to',
    type: 'evidence',
    pattern: clausePattern(String.raw`\baccording to (?:the )?(${CLAUSE_BODY}{2,120}?)(?:[,.;]|\sthen|$)`),
    group: 1,
    evidenceGroup: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.evidence,
  },
  // "from the X, ..."  (only when followed by a verb phrase - avoids "from the start")
  {
    label: 'from-the',
    type: 'evidence',
    pattern: clausePattern(String.raw`\bfrom the (${CLAUSE_BODY}{2,120}?)(?:[,.;]|\sthen|$)`),
    group: 1,
    evidenceGroup: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.evidence,
  },
  // "the error says X" / "the error message says X" / "the error indicates X"
  // Quoted span keeps its original tight class (no bare ';' inside quotes).
  {
    label: 'error-says',
    type: 'evidence',
    pattern: /\bthe error(?: message)? (?:says|indicates|shows|states) "?([^";!?\n]{2,140})"?/i,
    group: 1,
    evidenceGroup: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.evidence,
  },

  // ── Causal claims ──────────────────────────────────────────────────────
  // "because of X" - split from bare "because" so group 1 always holds the
  // belief text (the previous single pattern used group 2 and never fired for
  // the "because of" branch). See BUILD-SPEC §5.
  {
    label: 'because-of',
    type: 'causal',
    pattern: clausePattern(String.raw`\bbecause of\s+(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.causal,
  },
  // "because X" / ", because X"  (not "because of", handled above)
  {
    label: 'because',
    type: 'causal',
    pattern: clausePattern(String.raw`\bbecause\s+(?!of\b)(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.causal,
  },
  // "since X" - but NOT temporal "since [year]"; require a verb-ish word after.
  {
    label: 'since-causal',
    type: 'causal',
    pattern: clausePattern(String.raw`\bsince\s+(?!the\s+\d|\d{4})(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.causal,
  },
  // "due to X" / "as a result of X"
  {
    label: 'due-to',
    type: 'causal',
    pattern: clausePattern(String.raw`\b(?:due to|as a result of)\s+(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.causal,
  },

  // ── Assumptions ─────────────────────────────────────────────────────────
  // "assuming X" / "presumably X"
  {
    label: 'assuming',
    type: 'assumption',
    pattern: clausePattern(String.raw`\b(?:assuming|presumably)\s+(?:that\s+)?(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.assumption,
  },
  // "I'll assume X" / "I will assume X" / "let's assume X"
  {
    label: 'i-assume',
    type: 'assumption',
    pattern: clausePattern(String.raw`\b(?:i(?:'ll| will)|let's|let us) assume\s+(?:that\s+)?(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.assumption,
  },
  // "I'm assuming X" / "I am assuming X" - continuous form of "I assume".
  {
    label: 'im-assuming',
    type: 'assumption',
    pattern: clausePattern(String.raw`\bi(?:'m| am) assuming\s+(?:that\s+)?(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.assumption,
  },
  // "if X then Y" - captures X as assumption (group 1), Y as action (group 2)
  {
    label: 'if-then',
    type: 'assumption',
    pattern: clausePattern(String.raw`\bif\s+(${CLAUSE_BODY}{2,100}?)\s+then\s+(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    actionGroup: 2,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.assumption,
  },

  // ── Intentions ──────────────────────────────────────────────────────────
  // "I'll do X" / "I will do X" / "I'm going to X" / "let me X" / "I should X"
  // Capture the action phrase that follows.
  {
    label: 'i-will',
    type: 'intention',
    // Sequential planning language is handled by the more specific planning
    // patterns below. Keeping it out of this generic intent pattern lets
    // callers see a genuine planning event for "first/next/then I'll ...".
    pattern: clausePattern(String.raw`(?<!first )(?<!next )(?<!then )\b(?:i(?:'ll| will|(?:'m| am) going to)|let me(?!\s+reconsider\b)|i should)\s+(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.intention,
  },
  // "I'm going to refactor the auth module." → covered above.
  // "I plan to X" / "I intend to X"
  {
    label: 'i-plan',
    type: 'intention',
    pattern: clausePattern(String.raw`\bi (?:plan|intend)\s+to\s+(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.intention,
  },
  // Literal belief markers: "I believe X" / "I think X" / "I believe that X".
  // "I believe" reads as a held conviction about what follows, so it lands in
  // the intention family rather than next to the assumption patterns.
  {
    label: 'i-believe',
    type: 'intention',
    pattern: clausePattern(String.raw`\bi believe\s+(?:that\s+)?(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.intention,
  },
  // "I think X" - the other canonical literal belief marker.
  {
    label: 'i-think',
    type: 'intention',
    pattern: clausePattern(String.raw`\bi think\s+(?:that\s+)?(${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.intention,
  },

  // ── Uncertainty ───────────────────────────────────────────────────────
  // Keep the marker with the clause so a standalone "I'm not sure." remains
  // useful on the timeline rather than producing an empty capture.
  {
    label: 'uncertainty-hedge',
    type: 'uncertainty',
    pattern: clausePattern(String.raw`\b((?:i(?:'m| am) not sure|it(?:'s| is) unclear|this could be wrong|hard to say|i doubt)(?:\s+${CLAUSE_BODY}{0,120})?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.uncertainty,
  },

  // ── Contradictions / qualifications ───────────────────────────────────
  {
    label: 'contradiction-transition',
    type: 'contradiction',
    pattern: clausePattern(String.raw`\b(?:however|but actually|on the other hand|that said|nevertheless)\b(?:[,:]?\s*)(${CLAUSE_BODY}{2,140}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.contradiction,
  },

  // ── Planning ──────────────────────────────────────────────────────────
  {
    label: 'planning-sequence',
    type: 'planning',
    pattern: clausePattern(String.raw`\b((?:first|next|then)\s*,?\s*i(?:'ll| will)\s+${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.planning,
  },
  {
    label: 'planning-step',
    type: 'planning',
    pattern: clausePattern(String.raw`\b(step\s*1(?:\s*[:.-]?\s*${CLAUSE_BODY}{0,120})?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.planning,
  },
  {
    label: 'planning-explicit',
    type: 'planning',
    pattern: clausePattern(String.raw`\b(the plan is\s+${CLAUSE_BODY}{2,120}?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES.planning,
  },

  // ── Self-correction ───────────────────────────────────────────────────
  {
    label: 'self-correction-wait',
    type: 'self-correction',
    pattern: clausePattern(String.raw`\b(wait(?:[,:]?\s+${CLAUSE_BODY}{0,120})?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES['self-correction'],
  },
  {
    label: 'self-correction-actually',
    type: 'self-correction',
    pattern: clausePattern(String.raw`\b(actually(?:[,:]?\s+${CLAUSE_BODY}{0,120})?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES['self-correction'],
  },
  {
    label: 'self-correction-reconsider',
    type: 'self-correction',
    pattern: clausePattern(String.raw`\b((?:let me reconsider|i made a mistake|upon reflection)(?:[,:]?\s+${CLAUSE_BODY}{0,120})?)${CLAUSE_END}`),
    group: 1,
    confidence: BELIEF_TYPE_CONFIDENCE_BASELINES['self-correction'],
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

/** Existing-turn confidence is multiplied by this factor once per newer turn. */
export const CONFIDENCE_DECAY_PER_TURN = 0.9;

/**
 * Apply temporal confidence decay after a belief has been extracted.
 *
 * Marker-adjusted extraction confidence still uses the [0.1, 1.0] clamp. A
 * stored belief may decay below 0.1 as it ages, which preserves the exact
 * `0.9 ^ turnsAgo` contract rather than silently flattening all old beliefs
 * at the same floor.
 */
export function decayConfidence(confidence: number, turnsAgo = 0): number {
  if (!Number.isFinite(confidence)) return 0;
  const age = Number.isFinite(turnsAgo) ? Math.max(0, Math.floor(turnsAgo)) : 0;
  return Math.max(0, Math.min(1, confidence * Math.pow(CONFIDENCE_DECAY_PER_TURN, age)));
}

/** Maximum characters of context to scan on each side of a match for markers. */
export const MARKER_SCAN_RADIUS = 80;
