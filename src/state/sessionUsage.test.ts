import { describe, expect, it } from "vitest";
import {
  EMPTY_CUMULATIVE_TOKEN_USAGE,
  mergeTokenUsage,
  normalizeTokenUsage,
  sumTokenUsage,
} from "./sessionUsage";

describe("normalizeTokenUsage", () => {
  it("keeps valid canonical token counts", () => {
    expect(
      normalizeTokenUsage({
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      }),
    ).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  });

  it("drops malformed fields while retaining valid counts", () => {
    expect(
      normalizeTokenUsage({
        prompt_tokens: 12.9,
        completion_tokens: -1,
        total_tokens: Number.NaN,
      }),
    ).toEqual({ prompt_tokens: 12 });
  });

  it("returns undefined for non-usage input", () => {
    expect(normalizeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeTokenUsage([])).toBeUndefined();
    expect(normalizeTokenUsage({ input_tokens: 5 })).toBeUndefined();
  });
});

describe("mergeTokenUsage", () => {
  it("uses the largest counter from cumulative stream snapshots", () => {
    const merged = mergeTokenUsage(
      { prompt_tokens: 10, completion_tokens: 1 },
      { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
    );
    expect(merged).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    });
  });

  it("does not mutate either input", () => {
    const first = { prompt_tokens: 3 };
    const second = { completion_tokens: 2 };
    const merged = mergeTokenUsage(first, second);
    expect(merged).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(first).toEqual({ prompt_tokens: 3 });
    expect(second).toEqual({ completion_tokens: 2 });
  });
});

describe("sumTokenUsage", () => {
  it("sums calls and derives a missing per-call total from components", () => {
    expect(
      sumTokenUsage([
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        { prompt_tokens: 7, completion_tokens: 3 },
        undefined,
      ]),
    ).toEqual({ prompt_tokens: 17, completion_tokens: 8, total_tokens: 25 });
  });

  it("returns an independent zero record for no usage", () => {
    const result = sumTokenUsage([]);
    expect(result).toEqual(EMPTY_CUMULATIVE_TOKEN_USAGE);
    expect(result).not.toBe(EMPTY_CUMULATIVE_TOKEN_USAGE);
  });
});
