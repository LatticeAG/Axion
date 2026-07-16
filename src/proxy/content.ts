/**
 * Axion Lens - Assistant text normalization.
 *
 * Turns a provider's completed (non-streaming) response body, or the already
 * accumulated SSE delta text, into a single plain-text string suitable for
 * belief extraction. We never feed raw JSON to the lens: non-SSE bodies are
 * parsed via the provider-specific extractor below.
 *
 * These functions are intentionally defensive - a malformed or unexpected body
 * yields "" rather than throwing, because extraction runs in the background and
 * must never break the proxy.
 */

import type { ProviderId } from "./providers/types";

/**
 * Extract the assistant text from an OpenAI chat completion (non-streaming)
 * response body. Reads `choices[0].message.content`, which is either a string
 * or an array of content parts (`{ type: "text", text }` or bare strings).
 */
export function extractOpenAIAssistantText(rawBody: string): string {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return "";
  }

  const content = (json as any)?.choices?.[0]?.message?.content;
  return contentToText(content);
}

/**
 * Extract the assistant text from an Anthropic Messages (non-streaming)
 * response body. Joins every `content[]` block where `type === "text"`.
 */
export function extractAnthropicAssistantText(rawBody: string): string {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return "";
  }

  const content = (json as any)?.content;
  if (!Array.isArray(content)) {
    // Some payloads may carry a bare string content; be lenient.
    return typeof content === "string" ? content : "";
  }

  let text = "";
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

/**
 * Normalize assistant text for a response, regardless of transport.
 *
 * - SSE: `accumulated` already holds the joined delta text (produced by the
 *   stream tee), so we just return it (trimmed of surrounding whitespace).
 * - Non-SSE: `accumulated` is the raw response body; parse it with the
 *   provider-specific extractor.
 */
export function extractAssistantText(opts: {
  provider: ProviderId;
  isSse: boolean;
  accumulated: string;
}): string {
  const { provider, isSse, accumulated } = opts;

  if (isSse) {
    return accumulated.trim();
  }

  const raw = provider === "anthropic"
    ? extractAnthropicAssistantText(accumulated)
    : extractOpenAIAssistantText(accumulated);

  return raw.trim();
}

/**
 * Coerce an OpenAI-style `content` value (string | array of parts) into text.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
    } else if (part && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}
