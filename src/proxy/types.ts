/**
 * Axion Lens - Proxy types.
 *
 * Shared type definitions for the proxy layer. These describe the request/response
 * shapes that flow through the worker so callers don't depend on any upstream SDK.
 */

/** Bindings exposed to the Worker by wrangler.toml. */
export interface Env {
  /** Legacy OpenAI-only base URL override. Prefer UPSTREAM_OPENAI_URL. */
  UPSTREAM_API_URL?: string;
  /** OpenAI adapter base. Default https://api.openai.com */
  UPSTREAM_OPENAI_URL?: string;
  /** Anthropic adapter base. Default https://api.anthropic.com */
  UPSTREAM_ANTHROPIC_URL?: string;
  /** API key for the upstream model API (secret). Optional: callers may pass
   * their own credentials via Authorization or x-api-key instead. */
  UPSTREAM_API_KEY?: string;
  /** Shared secret for every public read API. Production deploys must set this. */
  AXION_READ_TOKEN?: string;
  /** Local-only escape. Must be the string "true" to disable read auth. */
  AXION_OPEN_READ?: string;
  /** Exact Origin value to reflect in ACAO. Unset means no CORS headers. */
  AXION_CORS_ORIGIN?: string;
  /** Signed belief-batch webhook URL. Feature 2. */
  AXION_BELIEF_WEBHOOK_URL?: string;
  /** HMAC secret for webhook signatures. */
  AXION_WEBHOOK_SECRET?: string;
  /** Dev-only: allow unsigned webhook POSTs when the secret is unset. */
  AXION_WEBHOOK_ALLOW_UNSIGNED?: string;
  /** Opt-in storage of redacted tool arguments. */
  AXION_STORE_TOOL_ARGS?: string;
  /** Proxy body size cap in bytes. Default 1048576. */
  AXION_MAX_BODY_BYTES?: string;
  /** Per-session rolling batch cap. Default 200, clamped to [20, 1000]. */
  AXION_MAX_BELIEF_BATCHES?: string;
  /** Max session Durable Objects scanned per search request. Default 40. */
  AXION_SEARCH_MAX_SESSION_SCANS?: string;
  /** Server-only HMAC key for search cursors. Required for /api/search. */
  AXION_CURSOR_SECRET?: string;
  /** Durable Object namespace binding for per-session state. */
  SESSION: DurableObjectNamespace;
  /** Global Durable Object namespace binding for the cross-session index. */
  SESSION_REGISTRY: DurableObjectNamespace;
  /** Static assets binding for the dashboard. */
  ASSETS: Fetcher;
}

/**
 * A single belief extracted from a model response.
 *
 * This is the canonical lens shape (`ExtractedBelief`) so the proxy, the
 * Durable Object store, and the dashboard all agree on one record type.
 */
export type Belief = import('../lens/types.js').ExtractedBelief;

/** Result of belief extraction for a single response. */
export interface ExtractionResult {
  sessionId: string;
  beliefs: Belief[];
  rawText: string;
  timestamp: number;
  /** Canonical upstream token counts for this response, when supplied. */
  usage?: import("../state/sessionUsage").TokenUsage;
  /** Model requested for this call, used by the session registry. */
  modelName?: string;
  /** Upstream API shape that produced this call. */
  provider?: "openai" | "anthropic";
  /** Number of inbound messages supplied with this call. */
  messageCount?: number;
  /** Inbound `messages[]` length for this call, when the proxy sent it. */
  inboundMessageCount?: number;
  /** Secret-regex hits replaced on this batch before persist. */
  redactions?: number;
  /** Observed tool calls from this turn. Empty array when none. */
  actions?: import("./actions").ObservedAction[];
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
