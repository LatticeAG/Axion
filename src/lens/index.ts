/**
 * Axion Lens - public entrypoint.
 *
 * Re-exports the extraction engine and its types so consumers can do:
 *   import { extractBeliefs, type ExtractedBelief } from 'axion/lens';
 */

export { extractBeliefs } from './extract.js';
export {
  BELIEF_PATTERNS,
  BELIEF_TYPE_CONFIDENCE_BASELINES,
  BELIEF_TYPE_VISUALS,
  CONFIDENCE_MARKERS,
  CONFIDENCE_DECAY_PER_TURN,
  DEFAULT_CONFIDENCE,
  MARKER_SCAN_RADIUS,
  decayConfidence,
  type BeliefPattern,
  type BeliefTypeVisual,
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
