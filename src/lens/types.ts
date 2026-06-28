/**
 * Axion Lens - Type definitions
 *
 * All TypeScript interfaces for the belief extraction engine.
 *
 * Design notes:
 * - `ExtractedBelief` is the unit emitted per detected reasoning fragment.
 * - `BeliefNode` extends `ExtractedBelief` with graph edges so the same record
 *   can live in a DAG without a separate join table.
 * - `BeliefDAG` is the session-scoped graph: nodes + edges + root-cause lookup.
 */

/** The kind of reasoning fragment that was detected. */
export type BeliefType = 'causal' | 'assumption' | 'intention' | 'evidence';

/** Confidence markers map onto a numeric band. See `patterns.ts` for the bands. */
export type ConfidenceMarker =
  | 'certain' // definitely, certainly, absolutely  → ~1.0
  | 'likely' // probably, likely, almost certainly → ~0.85
  | 'possible' // might, could be, may             → ~0.6
  | 'uncertain' // not sure, unclear, unsure       → ~0.35
  | 'none'; // no marker detected                  → 0.7 default

/**
 * A single belief extracted from one model response.
 * This is the shape consumers of Axion Lens receive.
 */
export interface ExtractedBelief {
  /** Stable unique id (UUID v4 string). */
  id: string;
  /** Session this belief belongs to. */
  sessionId: string;
  /** What kind of reasoning fragment this is. */
  type: BeliefType;
  /** The extracted belief text (normalized, trimmed). */
  belief: string;
  /** Cited evidence, if any (e.g. "the error message"). */
  evidence?: string;
  /** Confidence score in [0,1]. Derived from confidence markers. */
  confidence: number;
  /** If an action was stated alongside the belief, the action text. */
  actionTaken?: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** The surrounding raw text the belief was lifted from (for audit). */
  rawText: string;
  /** Line number in the source response where the match started (1-indexed). */
  line: number;
}

/**
 * A belief enriched with graph edges, for the session DAG.
 * `BeliefNode` is what the state layer (Durable Object) stores.
 */
export interface BeliefNode extends ExtractedBelief {
  /** Ids of beliefs this one depends on (was derived from). */
  parentIds: string[];
  /** Ids of beliefs derived from this one. */
  childIds: string[];
  /** True if a later outcome proved this belief wrong. Set post-hoc. */
  invalidated?: boolean;
}

/** Directed edge in the belief DAG. */
export interface BeliefEdge {
  fromId: string;
  toId: string;
  /** Why the edge exists - "derived", "contradicts", "supports". */
  relation: 'derived' | 'contradicts' | 'supports';
}

/**
 * The full belief DAG for a session.
 * Stored per-session; rebuilt on load from the node list.
 */
export interface BeliefDAG {
  sessionId: string;
  nodes: BeliefNode[];
  edges: BeliefEdge[];
  /** Monotonic counter for ordering even when timestamps tie. */
  sequence: number;
}

/** A raw match from the pattern engine, before it is shaped into a belief. */
export interface PatternMatch {
  /** Index of the pattern in `BELIEF_PATTERNS` that fired. */
  patternIndex: number;
  /** Which type this pattern classifies as. */
  type: BeliefType;
  /** The captured belief text (group 1 of the regex, or full match). */
  capture: string;
  /** The full substring that matched. */
  fullMatch: string;
  /** Start offset of the match within the input string. */
  index: number;
  /** Line number (1-indexed) where the match begins. */
  line: number;
  /** Optional evidence text captured by a named evidence group. */
  evidence?: string;
  /** Optional action text captured by a named action group. */
  action?: string;
}

export {};
