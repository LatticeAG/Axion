/**
 * Axion Lens — Proxy types.
 *
 * Shared type definitions for the proxy layer. These describe the request/response
 * shapes that flow through the worker so callers don't depend on any upstream SDK.
 */

/** Bindings exposed to the Worker by wrangler.toml. */
export interface Env {
  /** Base URL of the upstream model API, e.g. https://api.openai.com */
  UPSTREAM_API_URL: string;
  /** API key for the upstream model API (secret). */
  UPSTREAM_API_KEY: string;
  /** Durable Object namespace binding for per-session state. */
  SESSION: DurableObjectNamespace;
  /** Static assets binding for the dashboard. */
  ASSETS: Fetcher;
}

/** A single belief extracted from a model response. */
export interface Belief {
  id: string;
  belief: string;
  evidence: string;
  confidence: number;
  action_taken?: string;
  timestamp: number;
}

/** Result of belief extraction for a single response. */
export interface ExtractionResult {
  sessionId: string;
  beliefs: Belief[];
  rawText: string;
  timestamp: number;
}

/** Shape of the messages array in an OpenAI chat completion request. */
export interface ChatMessage {
  role: string;
  content: string | null | undefined;
}

/** Minimal OpenAI chat completion request shape (enough for proxying). */
export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

/** Parsed SSE delta content from a streaming chunk. */
export interface StreamChunk {
  /** Full raw SSE string (including `data: ` prefix and trailing `\n\n`). */
  raw: string;
  /** Concatenated delta text if this chunk carried content, else "". */
  text: string;
  /** True if this is the terminal `[DONE]` chunk. */
  done: boolean;
}
