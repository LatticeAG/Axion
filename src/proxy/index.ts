/**
 * Axion Lens - Cloudflare Worker entry point.
 *
 * Routes:
 *   POST /v1/chat/completions              OpenAI-compatible observe / PolyVerdict enforce
 *   POST /v1/messages                      Anthropic Messages observe / PolyVerdict enforce
 *   GET  /dashboard*                       dashboard static assets
 *   GET  /api/health                       unauthenticated liveness
 *   GET  /api/ready                        authenticated registry ping
 *   GET  /api/beliefs/:id                  flat belief timeline for a session
 *   GET  /api/search                       cross-session belief search
 *   GET  /api/export/all                   bulk session export
 *   GET  /api/sessions                     session registry page
 *   GET  /api/sessions/:id                 one registry record
 *   GET  /api/sessions/:id/export/json     single-session JSON export
 *   GET  /api/sessions/:id/export/markdown single-session Markdown export
 *   GET  /api/sessions/:id/usage           cumulative token usage
 *   GET  /api/sse/:id                      live belief stream
 *   OPTIONS /api/*                         CORS preflight
 *   GET  /                                 302 to /dashboard
 *
 * Default path is observe-only (tee + waitUntil extraction, zero added latency).
 * When a schema trigger is present (x-axion-schema or response_format.json_schema),
 * the request enters PolyVerdict enforce mode (buffered, may retry).
 * Read APIs require AXION_READ_TOKEN unless AXION_OPEN_READ=true.
 */

import type { Env } from "./types";
import { resolveUpstreamHeaders } from "./auth";
import { handleApiOptions } from "./cors";
import { extractAssistantText } from "./content";
import { extractObservedActions } from "./actions";
import { runExtraction, type ExtractionCallMetadata } from "./extraction";
import { teeResponseForExtraction } from "./stream";
import { extractTokenUsage } from "./usage";
import { handleDashboard, handleLegacyDashboardAsset } from "./routes";
import { fetchBeliefs } from "./beliefs";
import { fetchAllSessionsExport, fetchSessionExport } from "./export";
import { fetchHealth, fetchReady } from "./health";
import { fetchSearch } from "./search";
import { fetchSessionMetadata, fetchSessions } from "./sessions";
import { fetchSessionUsage } from "./sessionUsage";
import { fetchSessionSse } from "./sse";
import { matchProvider } from "./providers";
import type { ProviderAdapter, ProviderId } from "./providers/types";
import { resolveUpstreamUrl } from "./upstreamUrl";
import {
  sumTokenUsage,
  type CumulativeTokenUsage,
  type TokenUsage,
} from "../state/sessionUsage";
import {
  detectSchemaTrigger,
  buildRetryMessagesAnthropic,
  runEnforceLoop,
  type AnthropicMessage,
  type EnforceLoopResult,
  type OpenAiMessage,
  type SchemaTrigger,
} from "../polyverdict";

export { SessionDurableObject } from "../state/SessionDurableObject";
export { SessionRegistryDurableObject } from "../state/SessionRegistryDurableObject";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
      return handleApiOptions(request, env);
    }

    if (pathname === "/api/health" && request.method === "GET") {
      return fetchHealth(request, env);
    }

    if (pathname === "/api/ready" && request.method === "GET") {
      return fetchReady(request, env);
    }

    if (pathname.startsWith("/api/beliefs/") && request.method === "GET") {
      return fetchBeliefs(request, env, pathname);
    }

    if (pathname === "/api/search" && request.method === "GET") {
      return fetchSearch(request, env);
    }

    if (pathname === "/api/export/all" && request.method === "GET") {
      return fetchAllSessionsExport(request, env);
    }

    if (pathname === "/api/sessions" && request.method === "GET") {
      return fetchSessions(request, env);
    }

    if (
      /^\/api\/sessions\/[^/]+\/export\/(json|markdown)$/.test(pathname) &&
      request.method === "GET"
    ) {
      return fetchSessionExport(request, env, pathname);
    }

    if (/^\/api\/sessions\/[^/]+\/usage$/.test(pathname) && request.method === "GET") {
      return fetchSessionUsage(request, env, pathname);
    }

    if (/^\/api\/sse\/[^/]+$/.test(pathname) && request.method === "GET") {
      return fetchSessionSse(request, env, pathname);
    }

    // Keep nested V2 session routes (for example `/:id/usage` and exports)
    // available to their dedicated handlers instead of treating them as ids.
    if (/^\/api\/sessions\/[^/]+$/.test(pathname) && request.method === "GET") {
      return fetchSessionMetadata(request, env, pathname);
    }

    if (
      pathname === "/dashboard" ||
      pathname === "/dashboard/" ||
      pathname.startsWith("/dashboard/")
    ) {
      return handleDashboard(request, env);
    }

    if (pathname === "/styles.css" || pathname === "/app.js") {
      return handleLegacyDashboardAsset(request, env);
    }

    const provider = matchProvider(pathname, request.method);
    if (provider) {
      return proxyProviderRequest(request, env, ctx, provider);
    }

    if (pathname === "/") {
      return Response.redirect(
        new URL("/dashboard", request.url).toString(),
        302
      );
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// --- Proxy ----------------------------------------------------------------

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

async function proxyProviderRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  provider: ProviderAdapter
): Promise<Response> {
  const sessionId =
    request.headers.get("x-axion-session") || crypto.randomUUID();

  const auth = resolveUpstreamHeaders(request, env, provider.id);
  if (!auth.ok) {
    return auth.response;
  }

  const maxBytes = parseMaxBodyBytes(env.AXION_MAX_BODY_BYTES);
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return jsonError(413, "Request body too large");
    }
  }

  let body: Record<string, unknown>;
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError(400, "Invalid JSON request body");
  }
  if (utf8ByteLength(rawBody) > maxBytes) {
    return jsonError(413, "Request body too large");
  }
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON request body");
  }

  const validation = provider.validateRequest(body);
  if (!validation.ok) {
    return jsonError(400, validation.message);
  }

  const trigger = detectSchemaTrigger(request.headers, body);
  if (trigger) {
    return enforceProviderRequest({
      request,
      env,
      ctx,
      provider,
      sessionId,
      body,
      authHeaders: auth.headers,
      trigger,
    });
  }

  return observeProviderRequest({
    env,
    ctx,
    provider,
    sessionId,
    body,
    rawBody,
    authHeaders: auth.headers,
  });
}

/** Zero-latency observe path: tee upstream response, extract in waitUntil. */
async function observeProviderRequest(opts: {
  env: Env;
  ctx: ExecutionContext;
  provider: ProviderAdapter;
  sessionId: string;
  body: Record<string, unknown>;
  rawBody: string;
  authHeaders: Headers;
}): Promise<Response> {
  const { env, ctx, provider, sessionId, body, rawBody, authHeaders } = opts;
  const isStreaming = body.stream === true;
  const upstreamUrl = resolveUpstreamUrl(env, provider);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: authHeaders,
      body: rawBody,
    });
  } catch (err) {
    return jsonError(
      502,
      `Failed to reach upstream model API: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!upstreamRes.ok) {
    return withSessionHeader(upstreamRes, sessionId);
  }

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isSse =
    isStreaming || contentType.includes("text/event-stream");

  const { response, accumulatedText, accumulatedRaw } = teeResponseForExtraction(
    upstreamRes,
    isSse,
    provider.id
  );

  ctx.waitUntil(
    (async () => {
      const [accumulated, raw] = await Promise.all([accumulatedText, accumulatedRaw]);
      const text = extractAssistantText({
        provider: provider.id,
        isSse,
        accumulated,
      });
      const actions = await extractObservedActions({
        provider: provider.id,
        isSse,
        raw,
        storeArgs: env.AXION_STORE_TOOL_ARGS === "true",
      });
      await runExtraction(
        env,
        sessionId,
        text,
        extractionMetadata(body, provider.id, {
          usage: extractTokenUsage({ provider: provider.id, isSse, raw }),
          actions,
          waitUntil: (promise) => ctx.waitUntil(promise),
        }),
      );
    })()
  );

  return withSessionHeader(response, sessionId);
}

/** PolyVerdict enforce path: buffer, validate/coerce, retry ≤3 via runEnforceLoop. */
async function enforceProviderRequest(opts: {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  provider: ProviderAdapter;
  sessionId: string;
  body: Record<string, unknown>;
  authHeaders: Headers;
  trigger: SchemaTrigger;
}): Promise<Response> {
  const { env, ctx, provider, sessionId, body, authHeaders, trigger } = opts;
  const upstreamUrl = resolveUpstreamUrl(env, provider);
  const initialMessages = Array.isArray(body.messages)
    ? [...(body.messages as unknown[])]
    : [];

  // Accumulate per-attempt usage in this wrapper so runEnforceLoop stays a
  // (messages, attempt) => Promise<string> callback. Summed retries are the
  // cost of enforce, not a single completion.
  const attemptUsages: Array<TokenUsage | undefined> = [];
  let lastUsage: TokenUsage | undefined;
  let lastRaw = "";

  const callUpstream = async (messages: OpenAiMessage[]): Promise<string> => {
    const attemptBody: Record<string, unknown> = {
      ...body,
      stream: false,
      messages,
    };
    delete attemptBody.response_format;

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(attemptBody),
      });
    } catch (err) {
      throw new EnforceConnectError(err);
    }

    if (!upstreamRes.ok) {
      throw new EnforceUpstreamError(withSessionHeader(upstreamRes, sessionId));
    }

    lastRaw = await upstreamRes.text();
    lastUsage = extractTokenUsage({
      provider: provider.id,
      isSse: false,
      raw: lastRaw,
    });
    attemptUsages.push(lastUsage);
    return provider.extractAssistantText(lastRaw);
  };

  let loopResult: EnforceLoopResult;
  try {
    loopResult = await runEnforceLoop(
      initialMessages as OpenAiMessage[],
      trigger.schema,
      callUpstream,
      {
        name: trigger.name,
        buildRetry:
          provider.id === "anthropic"
            ? (messages, retryCtx) =>
                buildRetryMessagesAnthropic(
                  messages as unknown as AnthropicMessage[],
                  retryCtx,
                ) as unknown as OpenAiMessage[]
            : undefined,
      },
    );
  } catch (err) {
    if (err instanceof EnforceUpstreamError) return err.response;
    if (err instanceof EnforceConnectError) {
      return jsonError(502, err.message);
    }
    throw err;
  }

  const attemptsHeader = {
    "x-axion-enforce-attempts": String(loopResult.attempts),
  };

  if (loopResult.ok && loopResult.jsonText !== undefined) {
    const delivered = loopResult.jsonText;
    const summed = sumTokenUsage(attemptUsages);
    ctx.waitUntil(
      extractThenRun(env, sessionId, delivered, body, provider.id, ctx, {
        usage: summed,
        raw: lastRaw,
      }),
    );
    return withSessionHeader(
      buildEnforcedResponse(provider.id, body, delivered, summed),
      sessionId,
      attemptsHeader,
    );
  }

  // Exhausted retries: return 422 with last errors; extract last attempt usage.
  ctx.waitUntil(
    extractThenRun(env, sessionId, loopResult.finalText, body, provider.id, ctx, {
      usage: lastUsage,
      raw: lastRaw,
    }),
  );
  return withSessionHeader(
    new Response(
      JSON.stringify({
        error: {
          message: "PolyVerdict: output failed schema validation after retries",
          errors: loopResult.errors,
          attempts: loopResult.attempts,
        },
      }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" },
      },
    ),
    sessionId,
    attemptsHeader,
  );
}

function buildEnforcedResponse(
  provider: ProviderId,
  requestBody: Record<string, unknown>,
  jsonText: string,
  usage: CumulativeTokenUsage,
): Response {
  const model =
    typeof requestBody.model === "string" ? requestBody.model : "unknown";
  const id = `axion-pv-${crypto.randomUUID()}`;

  if (provider === "anthropic") {
    const payload = {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: jsonText }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: jsonText },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Helpers -------------------------------------------------------------

function parseMaxBodyBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
  return Math.floor(parsed);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function withSessionHeader(
  response: Response,
  sessionId: string,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-axion-session", sessionId);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      headers.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function extractionMetadata(
  body: Record<string, unknown>,
  provider: ProviderId,
  extra: ExtractionCallMetadata = {},
): ExtractionCallMetadata {
  const inboundMessageCount = Array.isArray(body.messages)
    ? body.messages.length
    : undefined;
  return {
    ...extra,
    modelName: typeof body.model === "string" ? body.model : undefined,
    provider,
    messageCount: inboundMessageCount,
    inboundMessageCount,
  };
}

/** Enforce waitUntil: parse lastRaw for tools, then persist. Never awaited by the caller. */
async function extractThenRun(
  env: Env,
  sessionId: string,
  text: string,
  body: Record<string, unknown>,
  provider: ProviderId,
  ctx: ExecutionContext,
  extra: { usage?: TokenUsage; raw: string },
): Promise<void> {
  const raw = extra.raw;
  const hasTools = raw.includes("tool_calls") || raw.includes("tool_use");
  const actions = hasTools
    ? await extractObservedActions({
        provider,
        isSse: false,
        raw,
        storeArgs: env.AXION_STORE_TOOL_ARGS === "true",
      })
    : [];
  await runExtraction(
    env,
    sessionId,
    text,
    extractionMetadata(body, provider, {
      usage: extra.usage,
      actions,
      waitUntil: (promise) => ctx.waitUntil(promise),
    }),
  );
}

class EnforceUpstreamError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super("enforce upstream error");
    this.response = response;
  }
}

class EnforceConnectError extends Error {
  constructor(cause: unknown) {
    super(
      `Failed to reach upstream model API: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
