/**
 * Tests for upstream auth resolution (BUILD-SPEC D1). Covers the passthrough
 * cases, the server-key cases for each provider, the no-credentials 401, and
 * the guarantee that we never emit `Bearer undefined`.
 */
import { describe, it, expect } from "vitest";
import { resolveUpstreamHeaders, DEFAULT_ANTHROPIC_VERSION } from "./auth";
import type { Env } from "./types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    UPSTREAM_API_URL: "https://api.openai.com",
    SESSION: {} as unknown as DurableObjectNamespace,
    ASSETS: {} as unknown as Fetcher,
    ...overrides,
  };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://worker.example/v1/chat/completions", {
    method: "POST",
    headers,
  });
}

describe("resolveUpstreamHeaders", () => {
  it("passes through a caller Authorization header as-is", () => {
    const result = resolveUpstreamHeaders(
      req({ Authorization: "Bearer sk-caller" }),
      makeEnv({ UPSTREAM_API_KEY: "sk-server" }),
      "openai"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers.get("Authorization")).toBe("Bearer sk-caller");
    expect(result.headers.get("Content-Type")).toBe("application/json");
  });

  it("passes through a caller x-api-key with a default anthropic-version", () => {
    const result = resolveUpstreamHeaders(
      req({ "x-api-key": "ak-caller" }),
      makeEnv(),
      "anthropic"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers.get("x-api-key")).toBe("ak-caller");
    expect(result.headers.get("anthropic-version")).toBe(
      DEFAULT_ANTHROPIC_VERSION
    );
    expect(result.headers.get("Authorization")).toBeNull();
  });

  it("forwards a caller-supplied anthropic-version", () => {
    const result = resolveUpstreamHeaders(
      req({ "x-api-key": "ak-caller", "anthropic-version": "2024-01-01" }),
      makeEnv(),
      "anthropic"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers.get("anthropic-version")).toBe("2024-01-01");
  });

  it("uses the server key as a Bearer token for OpenAI", () => {
    const result = resolveUpstreamHeaders(
      req(),
      makeEnv({ UPSTREAM_API_KEY: "sk-server" }),
      "openai"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers.get("Authorization")).toBe("Bearer sk-server");
    expect(result.headers.get("x-api-key")).toBeNull();
  });

  it("uses the server key as x-api-key for Anthropic", () => {
    const result = resolveUpstreamHeaders(
      req(),
      makeEnv({ UPSTREAM_API_KEY: "sk-server" }),
      "anthropic"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers.get("x-api-key")).toBe("sk-server");
    expect(result.headers.get("anthropic-version")).toBe(
      DEFAULT_ANTHROPIC_VERSION
    );
    expect(result.headers.get("Authorization")).toBeNull();
  });

  it("forwards OpenAI-Organization when present", () => {
    const result = resolveUpstreamHeaders(
      req({ Authorization: "Bearer sk-caller", "OpenAI-Organization": "org-123" }),
      makeEnv(),
      "openai"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers.get("OpenAI-Organization")).toBe("org-123");
  });

  it("returns a 401 JSON error when no credentials are available", async () => {
    const result = resolveUpstreamHeaders(req(), makeEnv(), "openai");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("Content-Type")).toBe(
      "application/json"
    );
    const body = (await result.response.json()) as {
      error: { message: string };
    };
    expect(body.error.message).toContain("UPSTREAM_API_KEY");
  });

  it("never emits `Bearer undefined` when the server key is empty/whitespace", () => {
    const empty = resolveUpstreamHeaders(
      req(),
      makeEnv({ UPSTREAM_API_KEY: "   " }),
      "openai"
    );
    expect(empty.ok).toBe(false);

    const missing = resolveUpstreamHeaders(
      req(),
      makeEnv({ UPSTREAM_API_KEY: undefined }),
      "openai"
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    // The failure path carries no Authorization header at all.
    expect(missing.response.status).toBe(401);
  });
});
