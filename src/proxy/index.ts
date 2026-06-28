/**
 * Axion Lens — Cloudflare Worker entry point.
 *
 * Sits between an AI agent and the model API. Streams responses through with
 * zero added latency and triggers belief extraction in the background via
 * ctx.waitUntil() after the stream completes.
 *
 * Routes:
 *   POST /v1/chat/completions   → proxy to upstream model API (OpenAI-compatible)
 *   GET  /dashboard             → dashboard HTML (served via ASSETS binding)
 *   GET  /api/beliefs/:sessionId → belief graph JSON from the Durable Object
 *
 * The proxy is OpenAI-compatible: it accepts the same request format and
 * returns the same response format (streaming or not) as the upstream API.
 */

import type { ChatCompletionRequest, Env } from "./types";
import { runExtraction } from "./extraction";
import { teeResponseForExtraction } from "./stream";
import { handleDashboard } from "./routes";
import { fetchBeliefs } from "./beliefs";

// Re-export the Durable Object class so wrangler can bind it from the
// entrypoint. wrangler.toml declares class_name = "SessionDurableObject".
export { SessionDurableObject } from "../state/SessionDurableObject";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- Routing -----------------------------------------------------------

    // Belief graph API — read from the Durable Object for a session.
    if (pathname.startsWith("/api/beliefs/") && request.method === "GET") {
      return fetchBeliefs(request, env, pathname);
    }

    // Dashboard — served via the ASSETS static binding.
    if (
      pathname === "/dashboard" ||
      pathname === "/dashboard/" ||
      pathname.startsWith("/dashboard/")
    ) {
      return handleDashboard(request, env);
    }

    // Chat completions proxy — the main event.
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      return proxyChatCompletion(request, env, ctx);
    }

    // Root → redirect to dashboard for human visitors.
    if (pathname === "/") {
      return Response.redirect(
        new URL("/dashboard", request.url).toString(),
        302
      );
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// --- Proxy ---------------------------------------------------------------

/**
 * Forward a chat completion request to the upstream model API, streaming the
 * response back with zero added latency. After the stream completes, belief
 * extraction runs in the background via ctx.waitUntil().
 */
async function proxyChatCompletion(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Resolve session ID (x-axion-session header or generate a UUID).
  const sessionId = request.headers.get("x-axion-session") || crypto.randomUUID();

  // Parse the body so we can inspect `stream` and pass it through.
  let body: ChatCompletionRequest;
  let rawBody: string;
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody) as ChatCompletionRequest;
  } catch {
    return jsonError(400, "Invalid JSON request body");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "Request must include a non-empty 'messages' array");
  }

  const isStreaming = body.stream === true;
  const upstreamUrl = resolveUpstreamUrl(env, "/v1/chat/completions");

  // Build the upstream request. We forward the parsed body (re-serialized)
  // so we control exactly what goes upstream.
  const upstreamReq = new Request(upstreamUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(request, env),
    body: rawBody,
  });

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamReq);
  } catch (err) {
    return jsonError(
      502,
      `Failed to reach upstream model API: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // If upstream returned an error, pass it through untouched.
  if (!upstreamRes.ok) {
    return upstreamRes;
  }

  const contentType = upstreamRes.headers.get("content-type") || "";
  const isSse =
    isStreaming || contentType.includes("text/event-stream");

  // Tee the body: one branch streams to the caller (untouched), the other
  // accumulates text for belief extraction. Zero added latency.
  const { response, accumulatedText } = teeResponseForExtraction(upstreamRes, isSse);

  // After the response is returned, run extraction in the background.
  ctx.waitUntil(
    (async () => {
      const text = await accumulatedText;
      await runExtraction(env, sessionId, text);
    })()
  );

  // Carry the session ID back in a header so callers can correlate.
  const headers = new Headers(response.headers);
  headers.set("x-axion-session", sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// --- Helpers -------------------------------------------------------------

/** Build the upstream URL from the env base URL + path. */
function resolveUpstreamUrl(env: Env, path: string): string {
  const base = (env.UPSTREAM_API_URL || "https://api.openai.com").replace(
    /\/+$/,
    ""
  );
  return `${base}${path}`;
}

/** Forward auth + content headers upstream, plus the API key. */
function buildUpstreamHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${env.UPSTREAM_API_KEY}`);

  // Forward the Organization header if the caller provided one (OpenAI uses it).
  const org = request.headers.get("OpenAI-Organization");
  if (org) headers.set("OpenAI-Organization", org);

  return headers;
}

/** Return a JSON error response. */
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
