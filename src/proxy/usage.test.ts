import { describe, expect, it } from "vitest";
import {
  extractJsonTokenUsage,
  extractSseTokenUsage,
  extractTokenUsage,
} from "./usage";

describe("extractJsonTokenUsage", () => {
  it("reads OpenAI prompt, completion, and total usage", () => {
    expect(
      extractJsonTokenUsage(
        "openai",
        JSON.stringify({
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      ),
    ).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it("normalizes Anthropic input/output counters to canonical fields", () => {
    expect(
      extractJsonTokenUsage(
        "anthropic",
        JSON.stringify({ usage: { input_tokens: 13, output_tokens: 5 } }),
      ),
    ).toEqual({ prompt_tokens: 13, completion_tokens: 5 });
  });

  it("returns undefined for malformed or absent usage", () => {
    expect(extractJsonTokenUsage("openai", "not json")).toBeUndefined();
    expect(extractJsonTokenUsage("anthropic", JSON.stringify({}))).toBeUndefined();
  });
});

describe("extractSseTokenUsage", () => {
  it("reads the OpenAI include_usage final chunk", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
      '',
      'data: [DONE]',
      '',
    ].join("\n");
    expect(extractSseTokenUsage("openai", raw)).toEqual({
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13,
    });
  });

  it("merges Anthropic message_start and message_delta counters without overcounting", () => {
    const raw = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":8}}',
      '',
    ].join("\n");
    expect(extractSseTokenUsage("anthropic", raw)).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
    });
  });

  it("ignores malformed events while retaining valid later usage", () => {
    const raw = [
      'data: {not-json}',
      '',
      'data: {"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
      '',
    ].join("\n");
    expect(extractSseTokenUsage("openai", raw)).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
  });
});

describe("extractTokenUsage", () => {
  it("dispatches between JSON and SSE transports", () => {
    const raw = JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } });
    expect(extractTokenUsage({ provider: "openai", isSse: false, raw })).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
    });
  });
});
