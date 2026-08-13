/**
 * Provider-aware token usage extraction. The proxy keeps this separate from
 * assistant-text extraction because usage can arrive in a final SSE event
 * after all visible text, or in the normal JSON body for non-streaming calls.
 */

import type { ProviderId } from "./providers/types";
import { SseLineParser } from "./stream";
import {
  mergeTokenUsage,
  normalizeTokenUsage,
  type TokenUsage,
} from "../state/sessionUsage";

export type { TokenUsage } from "../state/sessionUsage";

/** Extract canonical usage from a complete upstream response body. */
export function extractTokenUsage(opts: {
  provider: ProviderId;
  isSse: boolean;
  raw: string;
}): TokenUsage | undefined {
  if (!opts.raw.trim()) return undefined;
  return opts.isSse
    ? extractSseTokenUsage(opts.provider, opts.raw)
    : extractJsonTokenUsage(opts.provider, opts.raw);
}

/** Extract usage from a conventional non-streaming JSON response body. */
export function extractJsonTokenUsage(
  provider: ProviderId,
  raw: string,
): TokenUsage | undefined {
  try {
    return usageFromPayload(provider, JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Extract and merge cumulative usage snapshots from all SSE records. */
export function extractSseTokenUsage(
  provider: ProviderId,
  raw: string,
): TokenUsage | undefined {
  const parser = new SseLineParser();
  const payloads = [...parser.feed(raw), ...parser.flush()];
  let usage: TokenUsage | undefined;

  for (const payload of payloads) {
    if (payload.trim() === "[DONE]") continue;
    try {
      usage = mergeTokenUsage(usage, usageFromPayload(provider, JSON.parse(payload)));
    } catch {
      // A malformed SSE record must never affect the caller's response.
    }
  }
  return usage;
}

/** Normalize the distinct OpenAI and Anthropic response locations/shapes. */
function usageFromPayload(
  provider: ProviderId,
  payload: unknown,
): TokenUsage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const response = payload as Record<string, unknown>;
  if (provider === "anthropic") {
    // Anthropic uses `input_tokens` / `output_tokens`. In streamed Messages,
    // message_start nests the first snapshot under `message.usage` and
    // message_delta commonly puts the final output count at `usage`.
    const direct = anthropicUsage(response.usage);
    const nestedMessage = response.message;
    const nested =
      nestedMessage && typeof nestedMessage === "object" && !Array.isArray(nestedMessage)
        ? anthropicUsage((nestedMessage as Record<string, unknown>).usage)
        : undefined;
    return mergeTokenUsage(nested, direct);
  }

  return normalizeTokenUsage(response.usage);
}

function anthropicUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  return normalizeTokenUsage({
    prompt_tokens: source.input_tokens ?? source.prompt_tokens,
    completion_tokens: source.output_tokens ?? source.completion_tokens,
    total_tokens: source.total_tokens,
  });
}
