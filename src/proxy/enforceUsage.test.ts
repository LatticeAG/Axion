/**
 * Worker-level PolyVerdict enforce usage and inbound-count tests (G11, G12, G24).
 * Kept out of index.test.ts so a sibling can keep editing that file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";
import type { ExtractionResult } from "./types";

const SCHEMA = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
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

function makeEnv(stored: ExtractionResult[] = []): Env {
  const sessionStub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = toUrl(input);
      if (url.pathname === "/store-beliefs") {
        stored.push(JSON.parse(String(init?.body)) as ExtractionResult);
        return json({ ok: true, count: 0 });
      }
      return new Response("Not Found", { status: 404 });
    },
  } as unknown as DurableObjectStub;

  const registryStub = {
    fetch: async () => new Response("Not Found", { status: 404 }),
  } as unknown as DurableObjectStub;

  return {
    UPSTREAM_API_URL: "https://api.openai.com",
    AXION_READ_TOKEN: "test-read-token",
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
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return worker.fetch(request, env, ctx);
}

describe("Worker enforce usage honesty", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("embeds summed OpenAI usage.total_tokens across two attempts", async () => {
    const payloads = [
      {
        id: "cmpl-1",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "not json" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "cmpl-2",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: '{"n":1}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
    ];
    let i = 0;
    const seenBodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      void input;
      seenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json(payloads[i++] ?? payloads[payloads.length - 1]);
    };

    const stored: ExtractionResult[] = [];
    const { ctx, waitUntilCalls } = makeCtx();
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "x-axion-schema": JSON.stringify(SCHEMA),
          "x-axion-session": "sess-enforce",
        },
        body: JSON.stringify({
          model: "gpt-test",
          stream: true,
          response_format: {
            type: "json_schema",
            json_schema: { name: "N", schema: SCHEMA },
          },
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "n" },
          ],
        }),
      }),
      makeEnv(stored),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axion-enforce-attempts")).toBe("2");
    const body = (await response.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.usage).toEqual({
      prompt_tokens: 22,
      completion_tokens: 13,
      total_tokens: 35,
    });
    expect(body.usage.total_tokens).not.toBe(0);
    expect(seenBodies[0]?.stream).toBe(false);
    expect(seenBodies[0]).not.toHaveProperty("response_format");

    await Promise.all(waitUntilCalls);
    expect(stored[0]?.inboundMessageCount).toBe(2);
    expect(stored[0]?.messageCount).toBe(2);
    expect(stored[0]?.usage).toEqual({
      prompt_tokens: 22,
      completion_tokens: 13,
      total_tokens: 35,
    });
  });

  it("embeds summed Anthropic output_tokens across two attempts", async () => {
    const payloads = [
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "nope" }],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      {
        id: "msg-2",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: '{"n":1}' }],
        usage: { input_tokens: 5, output_tokens: 6 },
      },
    ];
    let i = 0;
    globalThis.fetch = async () => json(payloads[i++] ?? payloads[payloads.length - 1]);

    const stored: ExtractionResult[] = [];
    const { ctx, waitUntilCalls } = makeCtx();
    const response = await dispatch(
      new Request("https://worker.example/v1/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-ant-caller",
          "Content-Type": "application/json",
          "x-axion-schema": JSON.stringify(SCHEMA),
        },
        body: JSON.stringify({
          model: "claude-test",
          messages: [{ role: "user", content: "n" }],
        }),
      }),
      makeEnv(stored),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axion-enforce-attempts")).toBe("2");
    const body = (await response.json()) as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.usage).toEqual({ input_tokens: 8, output_tokens: 10 });
    expect(body.usage.output_tokens).not.toBe(0);
    await Promise.all(waitUntilCalls);
  });

  it("422 passes last-attempt usage into store-beliefs and sets enforce-attempts", async () => {
    let attempt = 0;
    globalThis.fetch = async () => {
      attempt += 1;
      return json({
        id: "cmpl-fail",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "nope" } }],
        usage: {
          prompt_tokens: attempt * 10,
          completion_tokens: attempt,
          total_tokens: attempt * 11,
        },
      });
    };

    const stored: ExtractionResult[] = [];
    const { ctx, waitUntilCalls } = makeCtx();
    const response = await dispatch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "x-axion-schema": JSON.stringify(SCHEMA),
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [
            { role: "user", content: "one" },
            { role: "user", content: "two" },
            { role: "user", content: "three" },
          ],
        }),
      }),
      makeEnv(stored),
      ctx,
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("x-axion-enforce-attempts")).toBe("3");
    await Promise.all(waitUntilCalls);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.usage).toEqual({
      prompt_tokens: 30,
      completion_tokens: 3,
      total_tokens: 33,
    });
    expect(stored[0]?.inboundMessageCount).toBe(3);
    expect(stored[0]?.messageCount).toBe(3);
  });
});
