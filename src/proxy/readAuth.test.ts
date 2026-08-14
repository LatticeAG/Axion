import { describe, expect, it } from "vitest";
import { extractReadToken, requireReadAuth, timingSafeEqualString } from "./readAuth";
import type { Env } from "./types";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SESSION: {} as DurableObjectNamespace,
    SESSION_REGISTRY: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
    ...overrides,
  };
}

function req(
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://worker.example${path}`, { headers });
}

describe("requireReadAuth", () => {
  it("fails closed when no token and open-read is unset", async () => {
    const result = requireReadAuth(req("/api/sessions"), env());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({
      error: { message: "Read authentication required" },
    });
  });

  it("accepts x-axion-read-token", () => {
    const result = requireReadAuth(
      req("/api/sessions", { "x-axion-read-token": "secret" }),
      env({ AXION_READ_TOKEN: "secret" }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts Authorization Bearer", () => {
    const result = requireReadAuth(
      req("/api/beliefs/s1", { Authorization: "Bearer secret" }),
      env({ AXION_READ_TOKEN: "secret" }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong token with the same 401 shape", async () => {
    const result = requireReadAuth(
      req("/api/sessions", { "x-axion-read-token": "nope" }),
      env({ AXION_READ_TOKEN: "secret" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({
      error: { message: "Read authentication required" },
    });
  });

  it("allows AXION_OPEN_READ=true without a token", () => {
    const result = requireReadAuth(
      req("/api/sessions"),
      env({ AXION_OPEN_READ: "true" }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not treat AXION_OPEN_READ=1 as open", async () => {
    const result = requireReadAuth(
      req("/api/sessions"),
      env({ AXION_OPEN_READ: "1" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });
});

describe("extractReadToken", () => {
  it("accepts ?readToken= only on GET /api/sse/:id", () => {
    expect(
      extractReadToken(
        new Request("https://worker.example/api/sse/s1?readToken=secret"),
      ),
    ).toBe("secret");
    expect(
      extractReadToken(
        new Request("https://worker.example/api/sessions?readToken=secret"),
      ),
    ).toBeNull();
    expect(
      extractReadToken(
        new Request("https://worker.example/api/beliefs/s1?readToken=secret"),
      ),
    ).toBeNull();
  });
});

describe("timingSafeEqualString", () => {
  it("matches equal strings and rejects length or content mismatch", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
  });
});
