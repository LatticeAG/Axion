/**
 * Axion Lens - Provider adapter interface.
 *
 * A ProviderAdapter describes how to route, validate, and normalize a single
 * upstream model API (OpenAI chat completions, Anthropic Messages). The proxy
 * matches an incoming request to an adapter, validates the body, forwards to
 * `upstreamPath`, and later normalizes the response text for belief extraction.
 */

export type ProviderId = "openai" | "anthropic";

/** Result of validating an inbound request body. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export interface ProviderAdapter {
  /** Stable identifier for this provider. */
  id: ProviderId;

  /** True if this adapter handles the given request path + method. */
  match(pathname: string, method: string): boolean;

  /** Path to forward to upstream (appended to the configured base URL). */
  upstreamPath: string;

  /** Validate the (already JSON-parsed) request body for this provider. */
  validateRequest(body: unknown): ValidationResult;

  /** Extract assistant text from a non-streaming response body. */
  extractAssistantText(rawBody: string): string;
}
