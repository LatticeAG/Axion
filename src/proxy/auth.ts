/**
 * Axion Lens - Upstream auth resolution.
 *
 * Implements the passthrough-first credential model (BUILD-SPEC D1):
 *   1. Caller `Authorization` header  → forward as-is (works for gateways).
 *   2. Caller `x-api-key` header       → forward + `anthropic-version`.
 *   3. `env.UPSTREAM_API_KEY` secret    → use the server key.
 *   4. None of the above                → 401 with a clear JSON error.
 *
 * We never emit `Bearer undefined`: the server key is only used when it trims
 * to a non-empty string.
 */

import type { Env } from "./types";

export type Provider = "openai" | "anthropic";

/** Default Anthropic API version used when the caller does not supply one. */
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * Discriminated result of auth resolution. Callers branch on `ok` instead of
 * catching thrown errors: on success they get the upstream `headers`, on
 * failure they get a ready-to-return 401 `response`.
 */
export type AuthResult =
  | { ok: true; headers: Headers }
  | { ok: false; response: Response };

/**
 * Resolve the headers to send upstream for a given provider, or a 401 Response
 * describing why credentials could not be resolved.
 */
export function resolveUpstreamHeaders(
  request: Request,
  env: Env,
  provider: Provider
): AuthResult {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  // OpenAI uses this to scope requests to an organization; forward if present.
  const org = request.headers.get("OpenAI-Organization");
  if (org) headers.set("OpenAI-Organization", org);

  const callerAuth = request.headers.get("Authorization")?.trim();
  const callerAnthropicKey = request.headers.get("x-api-key")?.trim();
  const callerAnthropicVersion = request.headers.get("anthropic-version")?.trim();
  const serverKey = env.UPSTREAM_API_KEY?.trim();

  if (callerAuth) {
    // Passthrough: caller owns their credentials (direct key or gateway token).
    headers.set("Authorization", callerAuth);
  } else if (callerAnthropicKey) {
    headers.set("x-api-key", callerAnthropicKey);
  } else if (serverKey) {
    if (provider === "anthropic") {
      headers.set("x-api-key", serverKey);
    } else {
      headers.set("Authorization", `Bearer ${serverKey}`);
    }
  } else {
    return {
      ok: false,
      response: authError(
        "Provide Authorization or x-api-key, or configure UPSTREAM_API_KEY"
      ),
    };
  }

  // Anthropic requires a version header; default it when we did a passthrough
  // x-api-key or used the server key on the Anthropic path.
  if (provider === "anthropic" && !headers.has("anthropic-version")) {
    headers.set(
      "anthropic-version",
      callerAnthropicVersion || DEFAULT_ANTHROPIC_VERSION
    );
  }

  return { ok: true, headers };
}

/** Build a 401 JSON error response in the `{ error: { message } }` shape. */
function authError(message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
