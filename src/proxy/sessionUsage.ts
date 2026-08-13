/**
 * Public handler for a session's cumulative model-token usage.
 *
 * The global registry owns discovery metadata, while the per-session Durable
 * Object owns exact call batches. This handler deliberately reads the latter
 * so totals remain correct even before a registry snapshot is refreshed.
 */

import type { Env } from "./types";

/** Extract one decoded id segment from `/api/sessions/:id/usage`. */
export function extractSessionUsageId(pathname: string): string | null {
  const match = /^\/api\/sessions\/([^/]+)\/usage$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!).trim();
    return id || null;
  } catch {
    return null;
  }
}

/** GET /api/sessions/:id/usage → cumulative session counters from SessionDO. */
export async function fetchSessionUsage(
  env: Env,
  pathname: string,
): Promise<Response> {
  const sessionId = extractSessionUsageId(pathname);
  if (!sessionId) return jsonError(400, "Missing session ID in path");

  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    const response = await stub.fetch(
      `https://internal/usage?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    return jsonError(
      502,
      `Failed to reach session state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
