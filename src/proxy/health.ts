/**
 * Liveness and readiness. Health never touches Durable Objects. Ready pings
 * the session registry with a 2s abort and does not sit on the observe path.
 */

import type { Env } from "./types";
import { jsonResponse } from "./cors";
import { requireReadAuth } from "./readAuth";
import { enforceReadRateLimit } from "./rateLimit";
import { getSessionRegistryStub } from "./sessions";

export const HEALTH_NAME = "axion";
export const HEALTH_VERSION = "0.1.0";
export const READY_REGISTRY_TIMEOUT_MS = 2000;

/** GET /api/health - unauthenticated liveness. */
export function fetchHealth(request: Request, env: Env): Response {
  return jsonResponse(request, env, {
    ok: true,
    name: HEALTH_NAME,
    version: HEALTH_VERSION,
  });
}

/** GET /api/ready - authenticated registry ping. Counts as a read for rate limits. */
export async function fetchReady(request: Request, env: Env): Promise<Response> {
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "read");
  if (limited) return limited;

  let registry: "up" | "down" = "down";
  try {
    const stub = getSessionRegistryStub(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READY_REGISTRY_TIMEOUT_MS);
    try {
      const response = await stub.fetch("https://internal/sessions?limit=1", {
        signal: controller.signal,
      });
      registry = response.ok ? "up" : "down";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    registry = "down";
  }

  return jsonResponse(request, env, {
    ok: registry === "up",
    registry,
  });
}
