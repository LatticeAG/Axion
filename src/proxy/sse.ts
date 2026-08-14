/**
 * Public live-belief SSE endpoint.
 *
 * The session Durable Object owns subscriber lifetime and event fan-out. This
 * Worker handler only validates the public path, forwards the client abort
 * signal to that object, and preserves the streaming body without buffering.
 */

import { SSE_RESPONSE_HEADERS } from "../state/sse.js";
import type { Env } from "./types";
import { applyCors, jsonErrorResponse } from "./cors";
import { requireReadAuth } from "./readAuth";
import { enforceReadRateLimit } from "./rateLimit";

/** Extract one decoded session id from `/api/sse/:sessionId`. */
export function extractSseSessionId(pathname: string): string | null {
  const match = /^\/api\/sse\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]!).trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/sse/:sessionId
 *
 * Returns a pass-through `text/event-stream` response from the session DO.
 * Do not await or inspect `response.body`: doing so would consume the live
 * stream and prevent EventSource clients from receiving future beliefs.
 * EventSource cannot set headers, so `?readToken=` is accepted here only.
 */
export async function fetchSessionSse(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "read");
  if (limited) return limited;

  const sessionId = extractSseSessionId(pathname);
  if (!sessionId) return jsonErrorResponse(request, env, 400, "Missing session ID in path");

  let response: Response;
  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    const target = `https://internal/sse?sessionId=${encodeURIComponent(sessionId)}`;
    response = await stub.fetch(new Request(target, { signal: request.signal }));
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

  const headers = new Headers(response.headers);
  if (response.ok) {
    for (const [name, value] of Object.entries(SSE_RESPONSE_HEADERS)) {
      headers.set(name, value);
    }
  } else {
    headers.set("Cache-Control", "no-cache, no-transform");
  }
  applyCors(request, env, headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
