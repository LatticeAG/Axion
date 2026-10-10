/**
 * Public handler for a session's retained per-batch turn window.
 *
 * The global registry owns discovery metadata, while the per-session Durable
 * Object owns exact call batches. This handler deliberately reads the latter
 * so the window reflects what is actually retained, not a registry snapshot.
 */

import type { Env } from "./types";
import { applyCors, jsonErrorResponse } from "./cors";
import { requireReadAuth } from "./readAuth";
import { enforceReadRateLimit } from "./rateLimit";

/** Extract one decoded id segment from `/api/sessions/:id/turns`. */
export function extractSessionTurnsId(pathname: string): string | null {
  const match = /^\/api\/sessions\/([^/]+)\/turns$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!).trim();
    return id || null;
  } catch {
    return null;
  }
}

/** GET /api/sessions/:id/turns → retained batch window from SessionDO. */
export async function fetchSessionTurns(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "read");
  if (limited) return limited;

  const sessionId = extractSessionTurnsId(pathname);
  if (!sessionId) return jsonErrorResponse(request, env, 400, "Missing session ID in path");

  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    const response = await stub.fetch(
      `https://internal/turns?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store");
    applyCors(request, env, headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    return jsonErrorResponse(
      request,
      env,
      502,
      `Failed to reach session state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
