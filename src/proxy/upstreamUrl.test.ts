import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_URL,
  DEFAULT_OPENAI_URL,
  resolveUpstreamUrl,
} from "./upstreamUrl";
import type { Env } from "./types";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SESSION: {} as DurableObjectNamespace,
    SESSION_REGISTRY: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
    ...overrides,
  };
}

const openai = { id: "openai" as const, upstreamPath: "/v1/chat/completions" };
const anthropic = { id: "anthropic" as const, upstreamPath: "/v1/messages" };

describe("resolveUpstreamUrl", () => {
  it("defaults OpenAI to api.openai.com and Anthropic to api.anthropic.com", () => {
    const empty = env();
    expect(resolveUpstreamUrl(empty, openai)).toBe(
      `${DEFAULT_OPENAI_URL}/v1/chat/completions`,
    );
    expect(resolveUpstreamUrl(empty, anthropic)).toBe(
      `${DEFAULT_ANTHROPIC_URL}/v1/messages`,
    );
  });

  it("uses UPSTREAM_API_URL for OpenAI only when the new vars are unset", () => {
    const legacy = env({ UPSTREAM_API_URL: "https://gateway.example/" });
    expect(resolveUpstreamUrl(legacy, openai)).toBe(
      "https://gateway.example/v1/chat/completions",
    );
    expect(resolveUpstreamUrl(legacy, anthropic)).toBe(
      `${DEFAULT_ANTHROPIC_URL}/v1/messages`,
    );
  });

  it("prefers per-provider vars over the legacy override", () => {
    const both = env({
      UPSTREAM_API_URL: "https://legacy.example",
      UPSTREAM_OPENAI_URL: "https://oai.example/",
      UPSTREAM_ANTHROPIC_URL: "https://ant.example/",
    });
    expect(resolveUpstreamUrl(both, openai)).toBe(
      "https://oai.example/v1/chat/completions",
    );
    expect(resolveUpstreamUrl(both, anthropic)).toBe(
      "https://ant.example/v1/messages",
    );
  });
});
