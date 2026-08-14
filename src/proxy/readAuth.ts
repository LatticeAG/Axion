/**
 * Read-API authentication. Session id is an identifier, not a capability.
 *
 * Accept Authorization: Bearer <token> or x-axion-read-token. GET /api/sse/:id
 * also accepts ?readToken= because EventSource cannot set headers.
 */

import type { Env } from "./types";
import { jsonErrorResponse } from "./cors";

export type ReadAuthResult =
  | { ok: true }
  | { ok: false; response: Response };

const UNAUTH_MESSAGE = "Read authentication required";

/** Require a valid read token unless local open-read is enabled. */
export function requireReadAuth(request: Request, env: Env): ReadAuthResult {
  if (env.AXION_OPEN_READ === "true") return { ok: true };

  const expected = env.AXION_READ_TOKEN?.trim() ?? "";
  if (!expected) {
    return { ok: false, response: deny(request, env) };
  }

  const provided = extractReadToken(request);
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return { ok: false, response: deny(request, env) };
  }
  return { ok: true };
}

/** Pull a read token from headers, or from the SSE query string only. */
export function extractReadToken(request: Request): string | null {
  const headerToken = request.headers.get("x-axion-read-token")?.trim();
  if (headerToken) return headerToken;

  const authorization = request.headers.get("Authorization")?.trim();
  if (authorization) {
    const match = /^Bearer\s+(\S+)/i.exec(authorization);
    const bearer = match?.[1]?.trim();
    if (bearer) return bearer;
  }

  const url = new URL(request.url);
  if (!/^\/api\/sse\/[^/]+$/.test(url.pathname)) return null;
  const queryToken = url.searchParams.get("readToken")?.trim();
  return queryToken || null;
}

function deny(request: Request, env: Env): Response {
  return jsonErrorResponse(request, env, 401, UNAUTH_MESSAGE);
}

/** Constant-time string compare for secrets. Length mismatch is a miss. */
export function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
