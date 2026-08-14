/**
 * Per-provider upstream base URLs.
 *
 * OpenAI defaults to https://api.openai.com. Anthropic defaults to
 * https://api.anthropic.com. UPSTREAM_API_URL remains a legacy OpenAI override
 * when UPSTREAM_OPENAI_URL is unset. Anthropic never inherits that OpenAI host.
 */

import type { Env } from "./types";
import type { ProviderId } from "./providers/types";

export const DEFAULT_OPENAI_URL = "https://api.openai.com";
export const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

let anthropicMisrouteWarned = false;

/** Resolve the full upstream URL for a provider path. */
export function resolveUpstreamUrl(
  env: Env,
  provider: { id: ProviderId; upstreamPath: string },
): string {
  const base =
    provider.id === "anthropic"
      ? resolveAnthropicBase(env)
      : resolveOpenAIBase(env);
  return `${stripTrailingSlash(base)}${provider.upstreamPath}`;
}

export function resolveOpenAIBase(env: Env): string {
  const explicit = env.UPSTREAM_OPENAI_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  const legacy = env.UPSTREAM_API_URL?.trim();
  if (legacy) return stripTrailingSlash(legacy);
  return DEFAULT_OPENAI_URL;
}

export function resolveAnthropicBase(env: Env): string {
  const explicit = env.UPSTREAM_ANTHROPIC_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  const base = DEFAULT_ANTHROPIC_URL;
  warnIfAnthropicMisrouted(base, env);
  return base;
}

function warnIfAnthropicMisrouted(base: string, env: Env): void {
  if (env.UPSTREAM_ANTHROPIC_URL?.trim()) return;
  let host = "";
  try {
    host = new URL(base).host;
  } catch {
    return;
  }
  if (host === "api.anthropic.com") return;
  if (anthropicMisrouteWarned) return;
  anthropicMisrouteWarned = true;
  console.warn(
    `axion: Anthropic traffic is using ${host} instead of api.anthropic.com`,
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
