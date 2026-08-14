/**
 * Public session-registry API handlers.
 *
 * The global SessionRegistryDurableObject is deliberately kept behind Worker
 * routes. This module is also the shared seam for server-side consumers such
 * as cross-session search and health metrics to obtain the global DO stub.
 */

import type { Env } from "./types";
import { SESSION_REGISTRY_INSTANCE_NAME } from "../state/sessionRegistry";
import { applyCors, jsonErrorResponse } from "./cors";
import { requireReadAuth } from "./readAuth";
import { enforceReadRateLimit } from "./rateLimit";

/** Stable name for Axion's one global session metadata registry instance. */
export const SESSION_REGISTRY_NAME = SESSION_REGISTRY_INSTANCE_NAME;

/** Return the global registry Durable Object stub for internal consumers. */
export function getSessionRegistryStub(env: Env): DurableObjectStub {
  const id = env.SESSION_REGISTRY.idFromName(SESSION_REGISTRY_NAME);
  return env.SESSION_REGISTRY.get(id);
}

/**
 * GET /api/sessions
 *
 * Public browsing is intentionally fixed at 20 records per page. The registry
 * itself accepts larger bounded pages for Worker-internal search and metrics,
 * but callers cannot inflate this endpoint into an unbounded list operation.
 */
export async function fetchSessions(request: Request, env: Env): Promise<Response> {
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "read");
  if (limited) return limited;

  const url = new URL(request.url);
  const registryUrl = new URL("https://session-registry.internal/sessions");
  registryUrl.searchParams.set("limit", "20");
  const cursor = url.searchParams.get("cursor");
  if (cursor) registryUrl.searchParams.set("cursor", cursor);

  return proxyRegistryResponse(request, env, registryUrl);
}

/** GET /api/sessions/:id. Return one session's registry metadata. */
export async function fetchSessionMetadata(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "read");
  if (limited) return limited;

  const sessionId = extractSessionMetadataId(pathname);
  if (!sessionId) return jsonErrorResponse(request, env, 400, "Missing session ID in path");

  const registryUrl = new URL(
    `https://session-registry.internal/session/${encodeURIComponent(sessionId)}`,
  );
  return proxyRegistryResponse(request, env, registryUrl);
}

/** Extract exactly one decoded id segment after `/api/sessions/`. */
export function extractSessionMetadataId(pathname: string): string | null {
  const prefix = "/api/sessions/";
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    const id = decodeURIComponent(encoded).trim();
    return id || null;
  } catch {
    return null;
  }
}

async function proxyRegistryResponse(
  request: Request,
  env: Env,
  target: URL,
): Promise<Response> {
  let response: Response;
  try {
    response = await getSessionRegistryStub(env).fetch(target.toString());
  } catch (error) {
    return jsonErrorResponse(
      request,
      env,
      502,
      `Failed to reach session registry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  applyCors(request, env, headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
