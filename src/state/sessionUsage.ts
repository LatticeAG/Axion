/**
 * Canonical token-usage helpers shared by proxy response parsing and session
 * storage. Providers use different field names, but Axion persists one stable
 * OpenAI-compatible shape for callers and exports.
 */

/** Token counts for one upstream model call, when the provider supplied them. */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Fully populated cumulative usage returned by the session usage endpoint. */
export interface CumulativeTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A zero-valued cumulative usage record. */
export const EMPTY_CUMULATIVE_TOKEN_USAGE: CumulativeTokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

/**
 * Keep only finite, non-negative token counts. Upstream counts are integral;
 * truncation avoids accidentally persisting fractional or malformed values.
 */
function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

/**
 * Normalize an unknown provider usage object to Axion's canonical shape.
 * Returns undefined when none of the supported fields have a valid value.
 */
export function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const prompt_tokens = normalizeTokenCount(source.prompt_tokens);
  const completion_tokens = normalizeTokenCount(source.completion_tokens);
  const total_tokens = normalizeTokenCount(source.total_tokens);

  if (
    prompt_tokens === undefined &&
    completion_tokens === undefined &&
    total_tokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(prompt_tokens === undefined ? {} : { prompt_tokens }),
    ...(completion_tokens === undefined ? {} : { completion_tokens }),
    ...(total_tokens === undefined ? {} : { total_tokens }),
  };
}

/**
 * Merge one or more streaming usage snapshots. Providers report cumulative
 * counters in stream events, so the largest valid value for each field is the
 * final count; summing snapshots would overcount the same request.
 */
export function mergeTokenUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!current) return next ? { ...next } : undefined;
  if (!next) return { ...current };

  const pickLargest = (a: number | undefined, b: number | undefined) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  };

  const prompt_tokens = pickLargest(current.prompt_tokens, next.prompt_tokens);
  const completion_tokens = pickLargest(
    current.completion_tokens,
    next.completion_tokens,
  );
  const total_tokens = pickLargest(current.total_tokens, next.total_tokens);

  return {
    ...(prompt_tokens === undefined ? {} : { prompt_tokens }),
    ...(completion_tokens === undefined ? {} : { completion_tokens }),
    ...(total_tokens === undefined ? {} : { total_tokens }),
  };
}

/**
 * Sum usage over independent model calls. If an upstream call did not supply
 * `total_tokens` but did provide either component count, derive that call's
 * total from its available components. This keeps Anthropic-style usage useful
 * while never double-counting a provider-supplied total.
 */
export function sumTokenUsage(
  usages: Iterable<TokenUsage | undefined | null>,
): CumulativeTokenUsage {
  const total = { ...EMPTY_CUMULATIVE_TOKEN_USAGE };
  for (const usage of usages) {
    if (!usage) continue;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    total.prompt_tokens += prompt;
    total.completion_tokens += completion;
    total.total_tokens += usage.total_tokens ?? prompt + completion;
  }
  return total;
}
