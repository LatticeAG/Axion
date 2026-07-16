/**
 * Axion Lens - Belief graph API.
 *
 * GET /api/beliefs/:sessionId → returns the belief graph for a session as JSON,
 * fetched from the session's Durable Object.
 */

import type { Env } from "./types";

/** Extract the session ID from a /api/beliefs/:sessionId path. */
export function extractSessionId(pathname: string): string | null {
  const prefix = "/api/beliefs/";
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  // Strip any trailing query/fragment cruft.
  const clean = id.split(/[/?#]/)[0];
  return clean || null;
}

/** Handle GET /api/beliefs/:sessionId - fetch the belief graph from the DO. */
export async function fetchBeliefs(
  _request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const sessionId = extractSessionId(pathname);
  if (!sessionId) {
    return jsonError(400, "Missing session ID in path");
  }

  let doRes: Response;
  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    // Pass the path sessionId as a hint so the DO can echo a human-readable
    // sessionId even if no beliefs have been written yet (DO returns flat).
    const hint = `https://internal/beliefs?sessionId=${encodeURIComponent(sessionId)}`;
    doRes = await stub.fetch(hint);
  } catch (err) {
    return jsonError(
      502,
      `Failed to reach session state: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Pass the DO response through, normalizing headers.
  const headers = new Headers(doRes.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(doRes.body, {
    status: doRes.status,
    statusText: doRes.statusText,
    headers,
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
