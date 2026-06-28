/**
 * Axion Lens - public entrypoint.
 *
 * Re-exports the extraction engine and its types so consumers can do:
 *   import { extractBeliefs, type ExtractedBelief } from 'axion/lens';
 */

export { extractBeliefs } from './extract.js';
export {
  BELIEF_PATTERNS,
  CONFIDENCE_MARKERS,
  DEFAULT_CONFIDENCE,
  MARKER_SCAN_RADIUS,
  type BeliefPattern,
  type ConfidenceMarkerPattern,
} from './patterns.js';
export type {
  BeliefType,
  ConfidenceMarker,
  ExtractedBelief,
  BeliefNode,
  BeliefEdge,
  BeliefDAG,
  PatternMatch,
} from './types.js';
