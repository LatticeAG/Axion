/**
 * Axion Lens - Provider registry + matcher.
 *
 * `matchProvider(pathname, method)` returns the adapter that handles a request,
 * or null when no provider claims it (the caller then falls through to 404 /
 * other routing).
 */

import { anthropicAdapter } from "./anthropic";
import { openaiAdapter } from "./openai";
import type { ProviderAdapter, ProviderId } from "./types";

/** All provider adapters, in match priority order. */
export const PROVIDERS: readonly ProviderAdapter[] = [
  openaiAdapter,
  anthropicAdapter,
];

/** Find the adapter that handles a request path + method, or null. */
export function matchProvider(
  pathname: string,
  method: string
): ProviderAdapter | null {
  for (const provider of PROVIDERS) {
    if (provider.match(pathname, method)) return provider;
  }
  return null;
}

/** Look up an adapter by its id. */
export function getProvider(id: ProviderId): ProviderAdapter {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown provider: ${id}`);
  return found;
}

export { openaiAdapter } from "./openai";
export { anthropicAdapter } from "./anthropic";
export type {
  ProviderAdapter,
  ProviderId,
  ValidationResult,
} from "./types";
