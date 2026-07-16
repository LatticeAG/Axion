/**
 * Axion Lens - Cloudflare Worker entry point.
 *
 * Routes:
 *   POST /v1/chat/completions  → OpenAI-compatible observe / PolyVerdict enforce
 *   POST /v1/messages          → Anthropic Messages observe / PolyVerdict enforce
 *   GET  /dashboard*           → dashboard static assets
 *   GET  /api/beliefs/:id      → flat belief timeline for a session
 *
 * Default path is observe-only (tee + waitUntil extraction, zero added latency).
 * When a schema trigger is present (x-axion-schema or response_format.json_schema),
 * the request enters PolyVerdict enforce mode (buffered, may retry).
 */

import type { Env } from "./types";
import { resolveUpstreamHeaders } from "./auth";
import { extractAssistantText } from "./content";
import { runExtraction } from "./extraction";
import { teeResponseForExtraction } from "./stream";
import { handleDashboard } from "./routes";
import { fetchBeliefs } from "./beliefs";
import { matchProvider } from "./providers";
import type { ProviderAdapter, ProviderId } from "./providers/types";
import {
  detectSchemaTrigger,
  enforceOnce,
  buildRetryMessages,
  buildRetryMessagesAnthropic,
  MAX_ENFORCE_ATTEMPTS,
  type SchemaTrigger,
} from "../polyverdict";

export { SessionDurableObject } from "../state/SessionDurableObject";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/beliefs/") && request.method === "GET") {
      return fetchBeliefs(request, env, pathname);
    }

    if (
      pathname === "/dashboard" ||
      pathname === "/dashboard/" ||
      pathname.startsWith("/dashboard/")
    ) {
      return handleDashboard(request, env);
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

async function proxyProviderRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  provider: ProviderAdapter
): Promise<Response> {
  const sessionId =
    request.headers.get("x-axion-session") || crypto.randomUUID();

  let body: Record<string, unknown>;
  let rawBody: string;
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON request body");
  }

  const validation = provider.validateRequest(body);
  if (!validation.ok) {
    return jsonError(400, validation.message);
  }

  const auth = resolveUpstreamHeaders(request, env, provider.id);
  if (!auth.ok) {
    return auth.response;
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
  const upstreamUrl = resolveUpstreamUrl(env, provider.upstreamPath);

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

  const { response, accumulatedText } = teeResponseForExtraction(
    upstreamRes,
    isSse,
    provider.id
  );

  ctx.waitUntil(
    (async () => {
      const accumulated = await accumulatedText;
      const text = extractAssistantText({
        provider: provider.id,
        isSse,
        accumulated,
      });
      await runExtraction(env, sessionId, text);
    })()
  );

  return withSessionHeader(response, sessionId);
}

/** PolyVerdict enforce path: buffer, validate/coerce, retry ≤3. */
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
  const upstreamUrl = resolveUpstreamUrl(env, provider.upstreamPath);

  // Enforce always forces non-streaming so we can validate the full payload.
  let messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
  let lastErrors: string[] = ["enforce did not run"];
  let lastText = "";

  for (let attempt = 1; attempt <= MAX_ENFORCE_ATTEMPTS; attempt++) {
    const attemptBody = {
      ...body,
      stream: false,
      messages,
    };
    // Strip client response_format so we own validation; keep model etc.
    delete (attemptBody as { response_format?: unknown }).response_format;

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(attemptBody),
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

    const raw = await upstreamRes.text();
    lastText = provider.extractAssistantText(raw);
    const result = enforceOnce(lastText, trigger.schema);

    if (result.ok && result.jsonText !== undefined) {
      const delivered = result.jsonText;
      ctx.waitUntil(runExtraction(env, sessionId, delivered));
      return withSessionHeader(
        buildEnforcedResponse(provider.id, body, delivered),
        sessionId
      );
    }

    lastErrors = result.errors;
    if (attempt < MAX_ENFORCE_ATTEMPTS) {
      const ctxRetry = {
        schema: trigger.schema,
        errors: result.errors,
        assistantText: lastText,
        name: trigger.name,
      };
      messages =
        provider.id === "anthropic"
          ? buildRetryMessagesAnthropic(messages as never, ctxRetry)
          : buildRetryMessages(messages as never, ctxRetry);
    }
  }

  // Exhausted retries: return 422 with last errors; still extract last text.
  ctx.waitUntil(runExtraction(env, sessionId, lastText));
  return new Response(
    JSON.stringify({
      error: {
        message: "PolyVerdict: output failed schema validation after retries",
        errors: lastErrors,
        attempts: MAX_ENFORCE_ATTEMPTS,
      },
    }),
    {
      status: 422,
      headers: {
        "Content-Type": "application/json",
        "x-axion-session": sessionId,
      },
    }
  );
}

function buildEnforcedResponse(
  provider: ProviderId,
  requestBody: Record<string, unknown>,
  jsonText: string
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
      usage: { input_tokens: 0, output_tokens: 0 },
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
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Helpers -------------------------------------------------------------

function resolveUpstreamUrl(env: Env, path: string): string {
  const base = (env.UPSTREAM_API_URL || "https://api.openai.com").replace(
    /\/+$/,
    ""
  );
  return `${base}${path}`;
}

function withSessionHeader(response: Response, sessionId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-axion-session", sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
