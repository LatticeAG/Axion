import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryRateLimitCache,
  RATE_LIMITS,
  enforceReadRateLimit,
  rateLimitKindForPath,
  setRateLimitCacheForTests,
} from "./rateLimit";
import type { Env } from "./types";
import worker from "./index";

const env = {
  AXION_READ_TOKEN: "test-read-token",
  AXION_CURSOR_SECRET: "cursor-secret-test",
} as Env;

function searchRequest(): Request {
  return new Request("https://worker.example/api/search?q=because", {
    headers: { "x-axion-read-token": "test-read-token" },
  });
}

describe("rateLimitKindForPath", () => {
  it("classifies search, export-all, other reads, and skips health", () => {
    expect(rateLimitKindForPath("/api/health")).toBeNull();
    expect(rateLimitKindForPath("/api/search")).toBe("search");
    expect(rateLimitKindForPath("/api/export/all")).toBe("exportAll");
    expect(rateLimitKindForPath("/api/sessions")).toBe("read");
    expect(rateLimitKindForPath("/api/ready")).toBe("read");
    expect(rateLimitKindForPath("/v1/chat/completions")).toBeNull();
  });
});

describe("enforceReadRateLimit", () => {
  afterEach(() => {
    setRateLimitCacheForTests(undefined);
  });

  it("returns 429 on the 31st search in one window", async () => {
    setRateLimitCacheForTests(new MemoryRateLimitCache());
    for (let i = 0; i < RATE_LIMITS.search; i++) {
      const allowed = await enforceReadRateLimit(searchRequest(), env, "search");
      expect(allowed).toBeNull();
    }
    const blocked = await enforceReadRateLimit(searchRequest(), env, "search");
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe("60");
    expect(await blocked?.json()).toEqual({
      error: { message: "Rate limit exceeded" },
    });
  });

  it("returns 429 on the 7th export-all in one window", async () => {
    setRateLimitCacheForTests(new MemoryRateLimitCache());
    const req = new Request("https://worker.example/api/export/all", {
      headers: { "x-axion-read-token": "test-read-token" },
    });
    for (let i = 0; i < RATE_LIMITS.exportAll; i++) {
      expect(await enforceReadRateLimit(req, env, "exportAll")).toBeNull();
    }
    const blocked = await enforceReadRateLimit(req, env, "exportAll");
    expect(blocked?.status).toBe(429);
  });

  it("fails closed on search when Cache is unusable", async () => {
    setRateLimitCacheForTests(undefined);
    const blocked = await enforceReadRateLimit(searchRequest(), env, "search");
    expect(blocked?.status).toBe(503);
    expect(await blocked?.json()).toEqual({
      error: { message: "Rate-limiter unavailable" },
    });
  });

  it("fails open on other reads when Cache is unusable", async () => {
    setRateLimitCacheForTests(undefined);
    const req = new Request("https://worker.example/api/sessions", {
      headers: { "x-axion-read-token": "test-read-token" },
    });
    expect(await enforceReadRateLimit(req, env, "read")).toBeNull();
  });
});

describe("Worker /api/search rate limit", () => {
  afterEach(() => {
    setRateLimitCacheForTests(undefined);
  });

  it("returns 429 on the 31st authenticated search in one window", async () => {
    setRateLimitCacheForTests(new MemoryRateLimitCache());
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const fullEnv = {
      ...env,
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
      SESSION_REGISTRY: {
        idFromName: () => "registry" as unknown as DurableObjectId,
        get: () => ({
          fetch: async () =>
            new Response(JSON.stringify({ sessions: [], nextCursor: null }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        }),
      },
      ASSETS: { fetch: async () => new Response("ok") },
    } as unknown as Env;

    let last = new Response("missing");
    for (let i = 0; i < RATE_LIMITS.search + 1; i++) {
      last = await worker.fetch(searchRequest(), fullEnv, ctx);
    }
    expect(last.status).toBe(429);
  });
});
