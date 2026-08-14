/**
 * CORS for read APIs. Reflect Origin only on an exact AXION_CORS_ORIGIN match.
 * Unset or mismatched origin means no Access-Control-Allow-Origin header.
 */

import type { Env } from "./types";

const PREFLIGHT_METHODS = "GET, OPTIONS";
const PREFLIGHT_HEADERS = "Authorization, x-axion-read-token, x-axion-session";
const PREFLIGHT_MAX_AGE = "600";

/** Exact-match Origin reflection. Empty object when CORS should be omitted. */
export function corsAllowOrigin(request: Request, env: Env): string | null {
  const allowed = env.AXION_CORS_ORIGIN?.trim();
  if (!allowed) return null;
  const origin = request.headers.get("Origin");
  if (!origin || origin !== allowed) return null;
  return origin;
}

/** Mutate headers with ACAO when the request Origin is allowed. */
export function applyCors(request: Request, env: Env, headers: Headers): Headers {
  const origin = corsAllowOrigin(request, env);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  else headers.delete("Access-Control-Allow-Origin");
  return headers;
}

/** OPTIONS /api/* preflight. Does not require a read token. */
export function handleApiOptions(request: Request, env: Env): Response {
  const headers = new Headers({
    "Access-Control-Allow-Methods": PREFLIGHT_METHODS,
    "Access-Control-Allow-Headers": PREFLIGHT_HEADERS,
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
  });
  applyCors(request, env, headers);
  return new Response(null, { status: 204, headers });
}

/** JSON error in the existing `{ error: { message } }` shape, with CORS policy. */
export function jsonErrorResponse(
  request: Request,
  env: Env,
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    ...(extraHeaders ?? {}),
  });
  applyCors(request, env, headers);
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

/** JSON success with CORS policy applied. */
export function jsonResponse(
  request: Request,
  env: Env,
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  });
  applyCors(request, env, headers);
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers,
  });
}
