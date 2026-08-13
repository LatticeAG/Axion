/**
 * Public live-belief SSE endpoint.
 *
 * The session Durable Object owns subscriber lifetime and event fan-out. This
 * Worker handler only validates the public path, forwards the client abort
 * signal to that object, and preserves the streaming body without buffering.
 */

import { SSE_RESPONSE_HEADERS } from "../state/sse.js";
import type { Env } from "./types";

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
 */
export async function fetchSessionSse(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const sessionId = extractSseSessionId(pathname);
  if (!sessionId) return jsonError(400, "Missing session ID in path");

  let response: Response;
  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    const target = `https://internal/sse?sessionId=${encodeURIComponent(sessionId)}`;
    // Passing the original signal lets a disconnected browser detach from the
    // DO immediately rather than waiting for the stream to be garbage-collected.
    response = await stub.fetch(new Request(target, { signal: request.signal }));
  } catch (error) {
    return jsonError(
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
    // An internal error is not an event stream. Preserve its content type but
    // still make it safe for a browser client to inspect and avoid caching it.
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "no-cache, no-transform");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
