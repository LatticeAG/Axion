/**
 * Fixed-window read-API rate limiter using the Cache API.
 *
 * Limits per token (or client IP when no token) per 60s bucket:
 *   search     30
 *   exportAll   6
 *   read      120  (other GET /api/* except /api/health)
 *
 * Search and export-all fail closed with 503 if Cache is unusable.
 * Other reads fail open so a Cache outage does not brick the dashboard.
 * Isolate-local Maps are forbidden: they lie across Worker isolates.
 */

import type { Env } from "./types";
import { jsonErrorResponse } from "./cors";
import { extractReadToken } from "./readAuth";

export type RateLimitKind = "search" | "exportAll" | "read";

export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMITS: Record<RateLimitKind, number> = {
  search: 30,
  exportAll: 6,
  read: 120,
};

export interface RateLimitCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

let cacheOverride: RateLimitCache | undefined;

/** Test-only Cache injection. Production uses caches.default. */
export function setRateLimitCacheForTests(cache: RateLimitCache | undefined): void {
  cacheOverride = cache;
}

/** In-memory Cache stand-in for Vitest. TTL is 60s from put. */
export class MemoryRateLimitCache implements RateLimitCache {
  private readonly store = new Map<string, { body: string; expiresAt: number }>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.store.get(cacheKey(request));
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(cacheKey(request));
      return undefined;
    }
    return new Response(hit.body);
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const body = await response.clone().text();
    this.store.set(cacheKey(request), {
      body,
      expiresAt: Date.now() + RATE_LIMIT_WINDOW_SECONDS * 1000,
    });
  }
}

/** Classify a read pathname. Health is never limited. */
export function rateLimitKindForPath(pathname: string): RateLimitKind | null {
  if (pathname === "/api/health") return null;
  if (pathname === "/api/search") return "search";
  if (pathname === "/api/export/all") return "exportAll";
  if (pathname.startsWith("/api/")) return "read";
  return null;
}

/**
 * Enforce the window for one authenticated read. Returns a 429/503 Response
 * when blocked, or null when the request may proceed.
 */
export async function enforceReadRateLimit(
  request: Request,
  env: Env,
  kind: RateLimitKind,
): Promise<Response | null> {
  const cache = resolveCache();
  if (!cache) {
    if (kind === "search" || kind === "exportAll") {
      return jsonErrorResponse(request, env, 503, "Rate-limiter unavailable");
    }
    return null;
  }

  const id = rateLimitIdentity(request);
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = new Request(`https://axion.rate-limit/rl:${encodeURIComponent(id)}:${kind}:${bucket}`);

  try {
    const hit = await cache.match(key);
    let count = 0;
    if (hit) {
      const parsed = Number(await hit.text());
      if (Number.isFinite(parsed) && parsed >= 0) count = parsed;
    }
    count += 1;
    if (count > RATE_LIMITS[kind]) {
      return jsonErrorResponse(request, env, 429, "Rate limit exceeded", {
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
      });
    }
    await cache.put(
      key,
      new Response(String(count), {
        headers: { "Cache-Control": `max-age=${RATE_LIMIT_WINDOW_SECONDS}` },
      }),
    );
    return null;
  } catch {
    if (kind === "search" || kind === "exportAll") {
      return jsonErrorResponse(request, env, 503, "Rate-limiter unavailable");
    }
    return null;
  }
}

function rateLimitIdentity(request: Request): string {
  const token = extractReadToken(request);
  if (token) return token;
  const ip = request.headers.get("CF-Connecting-IP")?.trim();
  if (ip) return ip;
  return "anon";
}

function resolveCache(): RateLimitCache | undefined {
  if (cacheOverride) return cacheOverride;
  try {
    const cachesObj = (globalThis as { caches?: { default?: RateLimitCache } }).caches;
    return cachesObj?.default;
  } catch {
    return undefined;
  }
}

function cacheKey(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.toString();
  if (request instanceof Request) return request.url;
  return String(request);
}
