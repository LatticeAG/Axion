/**
 * Axion Lens - Anthropic Messages adapter.
 *
 * Routes `POST /v1/messages`, validates a non-empty `messages[]`, and
 * normalizes non-streaming responses via the shared content extractor.
 */

import { extractAnthropicAssistantText } from "../content";
import type { ProviderAdapter, ValidationResult } from "./types";

const UPSTREAM_PATH = "/v1/messages";

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",

  match(pathname: string, method: string): boolean {
    return method.toUpperCase() === "POST" && pathname === UPSTREAM_PATH;
  },

  upstreamPath: UPSTREAM_PATH,

  validateRequest(body: unknown): ValidationResult {
    const messages = (body as any)?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        ok: false,
        message: "Request must include a non-empty 'messages' array",
      };
    }
    return { ok: true };
  },

  extractAssistantText(rawBody: string): string {
    return extractAnthropicAssistantText(rawBody);
  },
};

// Re-export the content helper for callers that want it directly.
export { extractAnthropicAssistantText };
