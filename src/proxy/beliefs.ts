/**
 * Belief timeline API.
 *
 * GET /api/beliefs/:sessionId returns the flat belief timeline for a session
 * as JSON, fetched from the session's Durable Object. Public responses omit
 * model-output rawText and default `actions` to [] when the DO did not send it.
 */

import type { Env } from "./types";
import { jsonErrorResponse, jsonResponse } from "./cors";
import { requireReadAuth } from "./readAuth";
import { enforceReadRateLimit } from "./rateLimit";

/** Extract the session ID from a /api/beliefs/:sessionId path. */
export function extractSessionId(pathname: string): string | null {
  const prefix = "/api/beliefs/";
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  const clean = id.split(/[/?#]/)[0];
  return clean || null;
}

/** Handle GET /api/beliefs/:sessionId - fetch the belief timeline from the DO. */
export async function fetchBeliefs(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "read");
  if (limited) return limited;

  const sessionId = extractSessionId(pathname);
  if (!sessionId) {
    return jsonErrorResponse(request, env, 400, "Missing session ID in path");
  }

  let doRes: Response;
  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    const hint = `https://internal/beliefs?sessionId=${encodeURIComponent(sessionId)}`;
    doRes = await stub.fetch(hint);
  } catch (err) {
    return jsonErrorResponse(
      request,
      env,
      502,
      `Failed to reach session state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!doRes.ok) {
    return jsonErrorResponse(
      request,
      env,
      502,
      `Failed to reach session state: session returned HTTP ${doRes.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await doRes.json();
  } catch {
    return jsonErrorResponse(
      request,
      env,
      502,
      "Failed to reach session state: invalid JSON",
    );
  }

  if (!isRecord(payload) || !Array.isArray(payload.beliefs)) {
    return jsonErrorResponse(
      request,
      env,
      502,
      "Failed to reach session state: invalid belief timeline",
    );
  }

  const beliefs = payload.beliefs.map((entry) => {
    if (!isRecord(entry)) return entry;
    return { ...entry, rawText: "" };
  });

  return jsonResponse(
    request,
    env,
    {
      ...payload,
      beliefs,
      actions: Array.isArray(payload.actions) ? payload.actions : [],
    },
    { status: doRes.status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
