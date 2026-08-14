/**
 * Worker route-table tests.
 *
 * Pre-registered assertion flips:
 * Phase 1 (applied): 401 (when token unset) for /api/sessions, /api/export/all,
 *   /api/search, /api/sse/:id, /api/sessions/:id, /api/sessions/:id/usage,
 *   /api/sessions/:id/export/json, /api/sessions/:id/export/markdown,
 *   /api/beliefs/:id; OPTIONS 204 for /api/*.
 * Phase 3 (applied): rawText stripped from /api/beliefs/:id and search results.
 *
 * Do not rewrite Lens.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";

const SAMPLE_METADATA = {
  id: "s1",
  createdAt: 1,
  updatedAt: 2,
  modelName: "gpt-test",
  provider: "openai",
  sessionName: "s1",
  messageCount: 0,
  tokenUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function makeEnv(): Env {
  const sessionStub = {
    fetch: async (input: RequestInfo | URL) => {
      const url = toUrl(input);
      if (url.pathname === "/beliefs") {
        return json({
          sessionId: "s1",
          beliefs: [
            {
              id: "b1",
              sessionId: "s1",
              type: "causal",
              belief: "rain causes delay",
              confidence: 0.7,
              timestamp: 1,
              rawText: "Because of rain.",
              line: 1,
            },
          ],
        });
      }
      if (url.pathname === "/usage") {
        return json({
          sessionId: "s1",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          calls: 0,
        });
      }
      if (url.pathname === "/export") {
        return json({
          sessionId: "s1",
          beliefs: [],
          batches: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          calls: 0,
        });
      }
      if (url.pathname === "/sse") {
        return new Response("", {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
      }
      if (url.pathname === "/store-beliefs") {
        return json({ ok: true, count: 0 });
      }
      return new Response("Not Found", { status: 404 });
    },
  } as unknown as DurableObjectStub;

  const registryStub = {
    fetch: async (input: RequestInfo | URL) => {
      const url = toUrl(input);
      if (url.pathname === "/sessions") {
        return json({ sessions: [], nextCursor: null });
      }
      if (url.pathname.startsWith("/session/")) {
        return json(SAMPLE_METADATA);
      }
      return new Response("Not Found", { status: 404 });
    },
  } as unknown as DurableObjectStub;

  return {
    UPSTREAM_API_URL: "https://api.openai.com",
    AXION_READ_TOKEN: "test-read-token",
    AXION_CURSOR_SECRET: "test-cursor-secret",
    SESSION: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => sessionStub,
    } as unknown as DurableObjectNamespace,
    SESSION_REGISTRY: {
      idFromName: () => "registry" as unknown as DurableObjectId,
      get: () => registryStub,
    } as unknown as DurableObjectNamespace,
    ASSETS: {
      fetch: async () =>
        new Response("<html>dashboard</html>", {
          headers: { "Content-Type": "text/html" },
        }),
    } as unknown as Fetcher,
  };
}

function makeCtx(): {
  ctx: ExecutionContext;
  waitUntilCalls: Promise<unknown>[];
} {
  const waitUntilCalls: Promise<unknown>[] = [];
  return {
    waitUntilCalls,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        waitUntilCalls.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext,
  };
}

async function dispatch(
  request: Request,
  env: Env = makeEnv(),
  ctx = makeCtx().ctx,
): Promise<Response> {
  return worker.fetch(request, env, ctx);
}

function authed(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-axion-read-token", "test-read-token");
  return new Request(url, { ...init, headers });
}

describe("Worker route table (Phase 1 read auth)", () => {
  it("GET /api/health is 200 without a token", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/health"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: "axion",
      version: "0.1.0",
    });
  });

  it("GET /api/sessions without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sessions"),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "Read authentication required" },
    });
  });

  it("GET /api/sessions with a token is 200", async () => {
    const response = await dispatch(
      authed("https://worker.example/api/sessions"),
    );
    expect(response.status).toBe(200);
  });

  it("GET /api/export/all without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/export/all"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/search without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/search?q=because"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/sse/:id without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sse/s1"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/sse/:id accepts ?readToken=", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sse/s1?readToken=test-read-token"),
    );
    expect(response.status).toBe(200);
  });

  it("GET /api/sessions/:id without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sessions/s1"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/sessions/:id/usage without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sessions/s1/usage"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/sessions/:id/export/json without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sessions/s1/export/json"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/sessions/:id/export/markdown without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sessions/s1/export/markdown"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/beliefs/:id without a token is 401", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/beliefs/s1"),
    );
    expect(response.status).toBe(401);
  });

  it("GET /api/beliefs/:id with a token is 200 and omits model-output rawText", async () => {
    const response = await dispatch(
      authed("https://worker.example/api/beliefs/s1"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      beliefs: { rawText: string }[];
      actions: unknown[];
    };
    expect(body.beliefs[0]?.rawText).toBe("");
    expect(body.actions).toEqual([]);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("GET /dashboard redirects to /dashboard/", async () => {
    const response = await dispatch(
      new Request("https://worker.example/dashboard"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://worker.example/dashboard/",
    );
  });

  it("GET /dashboard/ serves ASSETS without a read token", async () => {
    const response = await dispatch(
      new Request("https://worker.example/dashboard/"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("dashboard");
  });

  it("GET / redirects to /dashboard", async () => {
    const response = await dispatch(new Request("https://worker.example/"));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://worker.example/dashboard",
    );
  });

  it("unknown paths return 404", async () => {
    const response = await dispatch(
      new Request("https://worker.example/nope"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("OPTIONS /api/* returns 204", async () => {
    const response = await dispatch(
      new Request("https://worker.example/api/sessions", { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
  });

  it("invalid JSON on the observe path returns 400", async () => {
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
        },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid JSON request body");
  });

  it("rejects oversize proxy bodies with 413", async () => {
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "content-length": "2000000",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
  });
});

describe("Worker observe and enforce routing", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("observe calls waitUntil and returns the upstream body with a session header", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return json({
        id: "cmpl-1",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "Because of rain." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };

    const { ctx, waitUntilCalls } = makeCtx();
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "x-axion-session": "sess-1",
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "why?" }],
        }),
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axion-session")).toBe("sess-1");
    expect(waitUntilCalls.length).toBe(1);
    expect(seen[0]).toBe("https://api.openai.com/v1/chat/completions");
    await Promise.all(waitUntilCalls);
  });

  it("observe returns without awaiting tool-call parse failures", async () => {
    globalThis.fetch = async () =>
      json({
        id: "cmpl-tools",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will inspect the logs.",
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: { name: "lookup", arguments: "{not-json" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

    const { ctx, waitUntilCalls } = makeCtx();
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "x-axion-session": "sess-tools",
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "why?" }],
        }),
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axion-session")).toBe("sess-tools");
    expect(waitUntilCalls.length).toBe(1);
    await Promise.all(waitUntilCalls);
  });

  it("Anthropic observe uses api.anthropic.com by default", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return json({
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };

    const { ctx, waitUntilCalls } = makeCtx();
    const response = await dispatch(
      new Request("https://worker.example/v1/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-ant-caller",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-test",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(seen[0]).toBe("https://api.anthropic.com/v1/messages");
    await Promise.all(waitUntilCalls);
  });

  it("schema header branches to enforce (non-stream, mock fetch)", async () => {
    globalThis.fetch = async () =>
      json({
        id: "cmpl-1",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: '{"n":1}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      });

    const { ctx, waitUntilCalls } = makeCtx();
    const schema = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "x-axion-schema": JSON.stringify(schema),
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "n" }],
        }),
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe('{"n":1}');
    expect(waitUntilCalls.length).toBe(1);
    await Promise.all(waitUntilCalls);
  });
});
