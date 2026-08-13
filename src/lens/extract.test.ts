/**
 * Tests for the Axion Lens belief extraction engine.
 *
 * Covers the BUILD-SPEC §5 requirements:
 *   - "because of" now extracts a causal belief (previously silently dropped)
 *   - evidence patterns populate the `evidence` field
 *   - additive confidence modifiers, clamped to [0.1, 1.0]
 *   - end-of-string acts as a clause terminator
 *   - sessionId is stamped onto every belief when provided
 */
import { describe, it, expect } from 'vitest';
import { extractBeliefs } from './extract.js';
import {
  BELIEF_PATTERNS,
  BELIEF_TYPE_CONFIDENCE_BASELINES,
  BELIEF_TYPE_VISUALS,
  CONFIDENCE_DECAY_PER_TURN,
  CONFIDENCE_MARKERS,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
} from './patterns.js';
import type { ExtractedBelief } from './types.js';

/** Deterministic option overrides so ids/timestamps are stable in assertions. */
function fixedOpts(sessionId?: string) {
  let n = 0;
  return {
    sessionId,
    uuid: () => `id-${n++}`,
    now: () => 1_700_000_000_000,
  };
}

function findByType(beliefs: ExtractedBelief[], type: ExtractedBelief['type']) {
  return beliefs.filter((b) => b.type === type);
}

describe('extractBeliefs - empty / trivial input', () => {
  it('returns [] for empty, whitespace, or undefined-ish text', async () => {
    expect(await extractBeliefs('')).toEqual([]);
    expect(await extractBeliefs('   \n  ')).toEqual([]);
    // no reasoning markers at all
    expect(await extractBeliefs('Hello there, nice weather today.')).toEqual([]);
  });
});

describe('extractBeliefs - "because of" (BUILD-SPEC §5 fix)', () => {
  it('extracts a causal belief from "Because of the missing env var the app crashed."', async () => {
    const beliefs = await extractBeliefs(
      'Because of the missing env var the app crashed.',
      fixedOpts('s1'),
    );
    const causal = findByType(beliefs, 'causal');
    expect(causal.length).toBeGreaterThan(0);
    expect(causal[0]!.belief).toContain('missing env var');
    // must not include the connective itself
    expect(causal[0]!.belief.toLowerCase()).not.toContain('because of');
  });

  it('still extracts bare "because X" as causal', async () => {
    const beliefs = await extractBeliefs(
      'It failed because the token expired.',
      fixedOpts('s1'),
    );
    const causal = findByType(beliefs, 'causal');
    expect(causal.length).toBe(1);
    expect(causal[0]!.belief).toBe('the token expired');
  });

  it('does not double-count "because of" as both because-of and bare because', async () => {
    const beliefs = await extractBeliefs(
      'Because of the outage the deploy stalled.',
      fixedOpts('s1'),
    );
    expect(findByType(beliefs, 'causal').length).toBe(1);
  });
});

describe('extractBeliefs - evidence field', () => {
  it('populates both belief and evidence for "based on" patterns', async () => {
    const beliefs = await extractBeliefs(
      'Based on the logs, the request timed out.',
      fixedOpts('s1'),
    );
    const evidence = findByType(beliefs, 'evidence');
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.belief).toBe('logs');
    expect(evidence[0]!.evidence).toBe('logs');
  });

  it('captures evidence for "according to"', async () => {
    const beliefs = await extractBeliefs(
      'According to the changelog, the API was deprecated.',
      fixedOpts('s1'),
    );
    const evidence = findByType(beliefs, 'evidence');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]!.belief).toBe('changelog');
    expect(evidence[0]!.evidence).toBe('changelog');
  });

  it('every evidence pattern declares evidenceGroup = 1', () => {
    for (const p of BELIEF_PATTERNS.filter((p) => p.type === 'evidence')) {
      expect(p.evidenceGroup).toBe(1);
    }
  });
});

describe('extractBeliefs - end-of-string terminator', () => {
  it('extracts an intention when the sentence has no trailing punctuation', async () => {
    const beliefs = await extractBeliefs(
      'I will refactor the auth module',
      fixedOpts('s1'),
    );
    const intent = findByType(beliefs, 'intention');
    expect(intent.length).toBe(1);
    expect(intent[0]!.belief).toBe('refactor the auth module');
  });

  it('extracts a causal belief ending at end-of-string', async () => {
    const beliefs = await extractBeliefs(
      'The build broke because the lockfile drifted',
      fixedOpts('s1'),
    );
    const causal = findByType(beliefs, 'causal');
    expect(causal.length).toBe(1);
    expect(causal[0]!.belief).toBe('the lockfile drifted');
  });
});

describe('extractBeliefs - V2 reasoning types', () => {
  it.each([
    ['uncertainty', "I'm not sure the cache is warm."],
    ['contradiction', 'However, the cache is warm.'],
    ['planning', "First I'll inspect the logs."],
    ['planning', 'Step 1: inspect the logs.'],
    ['planning', 'The plan is to inspect the logs.'],
    ['self-correction', 'Wait, the cache key is wrong.'],
    ['self-correction', 'Let me reconsider the cache key.'],
    ['self-correction', 'Upon reflection, the cache key is wrong.'],
  ] as const)('extracts %s from %s', async (type, text) => {
    const beliefs = await extractBeliefs(text, fixedOpts('v2-types'));
    expect(findByType(beliefs, type)).toHaveLength(1);
  });

  it('recognizes every required uncertainty phrase', async () => {
    const text = [
      "I'm not sure the cache is warm.",
      "It's unclear why the request failed.",
      'This could be wrong in production.',
      'Hard to say whether the retry helped.',
      'I doubt the migration completed.',
    ].join('\n');
    expect(findByType(await extractBeliefs(text, fixedOpts('uncertain')), 'uncertainty')).toHaveLength(5);
  });

  it('recognizes every required contradiction phrase', async () => {
    const text = [
      'However, the cache is stale.',
      'On the other hand, the cache may be warm.',
      'That said, the cache has not expired.',
      'Nevertheless, the result is valid.',
    ].join('\n');
    expect(findByType(await extractBeliefs(text, fixedOpts('contradictions')), 'contradiction')).toHaveLength(4);
  });

  it('keeps the higher-confidence self-correction for a partial overlap', async () => {
    const beliefs = await extractBeliefs(
      'But actually, the dependency is incompatible.',
      fixedOpts('overlap'),
    );
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.type).toBe('self-correction');
    expect(beliefs[0]!.confidence).toBeCloseTo(0.5, 5);
  });

  it('exposes a visual color and icon for every belief type', () => {
    for (const type of Object.keys(BELIEF_TYPE_CONFIDENCE_BASELINES) as ExtractedBelief['type'][]) {
      expect(BELIEF_TYPE_VISUALS[type].color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(BELIEF_TYPE_VISUALS[type].icon.length).toBeGreaterThan(0);
    }
  });

  it('uses exactly the documented V2 type baselines', () => {
    expect(BELIEF_TYPE_CONFIDENCE_BASELINES).toEqual({
      causal: 0.7,
      assumption: 0.5,
      intention: 0.8,
      evidence: 0.6,
      uncertainty: 0.3,
      contradiction: 0.4,
      planning: 0.6,
      'self-correction': 0.5,
    });
  });
});

describe('extractBeliefs - additive confidence modifiers, clamped [0.1, 1.0]', () => {
  it('uses baseline confidence when no marker is present', async () => {
    const [b] = await extractBeliefs(
      'Because of the outage the deploy stalled.',
      fixedOpts('s1'),
    );
    // Every causal pattern shares the V2 causal baseline.
    expect(b!.confidence).toBeCloseTo(0.7, 5);
  });

  it('adds +0.1 for "probably"', async () => {
    const [b] = await extractBeliefs(
      'Because of the outage the deploy probably stalled.',
      fixedOpts('s1'),
    );
    expect(b!.confidence).toBeCloseTo(0.8, 5);
  });

  it('subtracts 0.2 for "might"', async () => {
    const [b] = await extractBeliefs(
      'Because of the outage the deploy might have stalled.',
      fixedOpts('s1'),
    );
    expect(b!.confidence).toBeCloseTo(0.5, 5);
  });

  it('subtracts 0.3 for "not sure"', async () => {
    const [b] = await extractBeliefs(
      "Because of the outage I'm not sure the deploy stalled.",
      fixedOpts('s1'),
    );
    expect(b!.confidence).toBeCloseTo(0.4, 5);
  });

  it('clamps the upper bound to 1.0 (0.8 + 0.2 + 0.1 = 1.1 → 1.0)', async () => {
    const [b] = await extractBeliefs(
      'I will definitely probably ship the release.',
      fixedOpts('s1'),
    );
    expect(b!.confidence).toBe(CONFIDENCE_MAX);
    expect(b!.confidence).toBe(1.0);
  });

  it('sums multiple distinct markers and clamps the lower bound to 0.1', async () => {
    // if-then baseline 0.6; "uncertain" (-0.3) + "might"/"possibly" (-0.2)
    // = -0.5 → 0.1 (floor).
    const [b] = await extractBeliefs(
      'If the migration is uncertain then it might possibly break.',
      fixedOpts('s1'),
    );
    expect(b!.confidence).toBe(CONFIDENCE_MIN);
    expect(b!.confidence).toBe(0.1);
  });

  it('never returns a confidence outside [0.1, 1.0] for any pattern', async () => {
    const text = [
      'Because of the outage the deploy definitely absolutely stalled.',
      'If the migration is uncertain unsure then it might possibly break.',
      'Based on the logs, it probably failed.',
    ].join('\n');
    const beliefs = await extractBeliefs(text, fixedOpts('s1'));
    expect(beliefs.length).toBeGreaterThan(0);
    for (const b of beliefs) {
      expect(b.confidence).toBeGreaterThanOrEqual(0.1);
      expect(b.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it('CONFIDENCE_MARKERS expose additive deltas matching the spec', () => {
    const byLabel = Object.fromEntries(CONFIDENCE_MARKERS.map((m) => [m.label, m.delta]));
    expect(byLabel.certain).toBe(0.2);
    expect(byLabel.likely).toBe(0.1);
    expect(byLabel.possible).toBe(-0.2);
    expect(byLabel.uncertain).toBe(-0.3);
  });
});

describe('extractBeliefs - turn-age confidence decay', () => {
  it('multiplies a newly extracted confidence by 0.9^turnsAgo', async () => {
    const [belief] = await extractBeliefs(
      'I will inspect the logs.',
      { ...fixedOpts('aged'), turnsAgo: 3 },
    );
    expect(belief!.confidence).toBeCloseTo(0.8 * Math.pow(CONFIDENCE_DECAY_PER_TURN, 3), 8);
  });

  it('treats negative and non-finite turn ages as the current turn', async () => {
    const [negative] = await extractBeliefs(
      'I will inspect the logs.',
      { ...fixedOpts('aged'), turnsAgo: -2 },
    );
    const [nonFinite] = await extractBeliefs(
      'I will inspect the logs.',
      { ...fixedOpts('aged'), turnsAgo: Number.NaN },
    );
    expect(negative!.confidence).toBeCloseTo(0.8, 8);
    expect(nonFinite!.confidence).toBeCloseTo(0.8, 8);
  });
});

describe('extractBeliefs - sessionId stamping', () => {
  it('stamps the provided sessionId onto every belief', async () => {
    const text = [
      'Because of the outage the deploy stalled.',
      'Based on the logs, it failed.',
      'I will roll back the release.',
    ].join('\n');
    const beliefs = await extractBeliefs(text, fixedOpts('session-abc'));
    expect(beliefs.length).toBeGreaterThan(1);
    for (const b of beliefs) {
      expect(b.sessionId).toBe('session-abc');
    }
  });

  it('generates a non-empty sessionId when none is provided', async () => {
    const beliefs = await extractBeliefs('Because of the outage the deploy stalled.');
    expect(beliefs.length).toBeGreaterThan(0);
    for (const b of beliefs) {
      expect(typeof b.sessionId).toBe('string');
      expect(b.sessionId.length).toBeGreaterThan(0);
    }
    // all beliefs from one call share the same generated session id
    const ids = new Set(beliefs.map((b) => b.sessionId));
    expect(ids.size).toBe(1);
  });
});

describe('extractBeliefs - belief shape', () => {
  it('stamps id, timestamp, rawText and line', async () => {
    const beliefs = await extractBeliefs(
      'Line one is filler.\nBecause of the outage the deploy stalled.',
      fixedOpts('s1'),
    );
    const b = beliefs[0]!;
    expect(b.id).toBe('id-0');
    expect(b.timestamp).toBe(1_700_000_000_000);
    expect(b.rawText.toLowerCase()).toContain('because of');
    expect(b.line).toBe(2);
  });
});
