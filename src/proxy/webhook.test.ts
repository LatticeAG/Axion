import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_SPEC,
  buildWebhookPayload,
  hmacSha256Hex,
  parseStoreResponse,
  sendWebhook,
} from "./webhook";
import { runExtraction } from "./extraction";
import worker from "./index";
import type { Env, ExtractionResult } from "./types";

function sampleResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    sessionId: "sess-hook",
    rawText: "I will inspect the logs because sk-ant-api03-TEST expired.",
    timestamp: 1,
    provider: "openai",
    modelName: "gpt-test",
    redactions: 1,
    actions: [],
    beliefs: [
      {
        id: "b1",
        sessionId: "sess-hook",
        type: "intention",
        belief: "inspect the logs",
        confidence: 0.8,
        timestamp: 1,
        rawText: "secret sk-ant-api03-TEST",
        line: 1,
      },
    ],
    ...overrides,
  };
}

describe("buildWebhookPayload", () => {
  it("uses spec axion.belief_batch.v1 and omits rawText", () => {
    const payload = buildWebhookPayload(sampleResult(), 4);
    expect(payload.spec).toBe(WEBHOOK_SPEC);
    expect(JSON.stringify(payload)).not.toContain("rawText");
    expect(JSON.stringify(payload)).not.toContain("sk-ant-api03-TEST");
    expect(payload.callsInSession).toBe(4);
    expect(payload.beliefs[0]).not.toHaveProperty("rawText");
  });
});

describe("parseStoreResponse", () => {
  it("reads callsInSession only from an ok store payload", () => {
    expect(parseStoreResponse({ ok: true, callsInSession: 7 })).toEqual({
      stored: true,
      callsInSession: 7,
    });
    expect(parseStoreResponse({ ok: false, callsInSession: 3 })).toEqual({
      stored: false,
      callsInSession: 3,
    });
    expect(parseStoreResponse(null)).toEqual({ stored: false, callsInSession: 0 });
  });
});

describe("sendWebhook", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refuses to send when the URL is set but the secret is missing", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      return new Response("ok", { status: 200 });
    };
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
    } as unknown as Env;
    const out = await sendWebhook(env, sampleResult(), 1);
    expect(out.sent).toBe(false);
    expect(seen).toEqual([]);
  });

  it("sends HMAC-signed JSON when secret is configured", async () => {
    const seen: { url: string; headers: Headers; body: string }[] = [];
    globalThis.fetch = async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response("ok", { status: 200 });
    };
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_SECRET: "hook-secret",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
    } as unknown as Env;
    const result = sampleResult();
    const out = await sendWebhook(env, result, 2);
    expect(out.sent).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://hooks.example/axion");
    expect(seen[0]?.headers.get("User-Agent")).toBe("axion-webhook/0.1.0");
    const body = seen[0]!.body;
    expect(JSON.parse(body).spec).toBe(WEBHOOK_SPEC);
    expect(body).not.toContain("rawText");
    const expected = await hmacSha256Hex("hook-secret", body);
    expect(seen[0]?.headers.get("x-axion-signature")).toBe(`sha256=${expected}`);
  });

  it("sends unsigned JSON when AXION_WEBHOOK_ALLOW_UNSIGNED=true", async () => {
    const seen: { headers: Headers }[] = [];
    globalThis.fetch = async (_input, init) => {
      seen.push({ headers: new Headers(init?.headers) });
      return new Response("ok", { status: 200 });
    };
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_ALLOW_UNSIGNED: "true",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
    } as unknown as Env;
    const out = await sendWebhook(env, sampleResult(), 1);
    expect(out.sent).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("x-axion-signature")).toBeNull();
  });

  it("retries a 500 sink then succeeds", async () => {
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      if (n < 2) return new Response("nope", { status: 500 });
      return new Response("ok", { status: 200 });
    };
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_SECRET: "hook-secret",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
    } as unknown as Env;
    const out = await sendWebhook(env, sampleResult(), 1);
    expect(out.sent).toBe(true);
    expect(n).toBe(2);
  });

  it("gives up after two retries on a 500 sink and bumps webhookFailures", async () => {
    let n = 0;
    const doPaths: string[] = [];
    globalThis.fetch = async () => {
      n += 1;
      return new Response("nope", { status: 500 });
    };
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_SECRET: "hook-secret",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL) => {
            doPaths.push(String(input));
            return new Response("{}", { status: 200 });
          },
        }),
      },
    } as unknown as Env;
    const out = await sendWebhook(env, sampleResult(), 1);
    expect(out.sent).toBe(false);
    expect(n).toBe(WEBHOOK_MAX_RETRIES + 1);
    expect(doPaths.some((path) => path.includes("/webhook-failure"))).toBe(true);
  });

  it("aborts each attempt after the timeout", async () => {
    let attempts = 0;
    globalThis.fetch = async (_input, init) => {
      attempts += 1;
      const signal = init?.signal;
      if (!signal) throw new Error("missing abort signal");
      await new Promise<never>((_, reject) => {
        const fail = () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail);
      });
      return new Response("ok", { status: 200 });
    };
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_SECRET: "hook-secret",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
    } as unknown as Env;
    const out = await sendWebhook(env, sampleResult(), 1, { timeoutMs: 5 });
    expect(out.sent).toBe(false);
    expect(attempts).toBe(WEBHOOK_MAX_RETRIES + 1);
  });
});

describe("observe path does not wait for webhook", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the upstream response before the webhook fetch settles", async () => {
    let resolveHook: ((value: Response) => void) | undefined;
    const hookPending = new Promise<Response>((resolve) => {
      resolveHook = resolve;
    });
    let hookStarted = false;

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("hooks.example")) {
        hookStarted = true;
        return hookPending;
      }
      return new Response(
        JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "I will inspect the logs." } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };

    const waitUntilCalls: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilCalls.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const env = {
      UPSTREAM_API_URL: "https://api.openai.com",
      AXION_READ_TOKEN: "test-read-token",
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_SECRET: "hook-secret",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({
          fetch: async () =>
            new Response(JSON.stringify({ ok: true, callsInSession: 1 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        }),
      },
      SESSION_REGISTRY: {
        idFromName: () => "registry" as unknown as DurableObjectId,
        get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
      },
      ASSETS: { fetch: async () => new Response("ok") },
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-caller",
          "Content-Type": "application/json",
          "x-axion-session": "sess-hook",
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "why?" }],
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(hookStarted).toBe(false);
    await waitUntilCalls[0];
    for (let i = 0; i < 20 && !hookStarted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(hookStarted).toBe(true);
    resolveHook?.(new Response("ok", { status: 200 }));
    await Promise.all(waitUntilCalls);
  });
});

describe("runExtraction webhook gating", () => {
  it("does not notify when the Durable Object store fails", async () => {
    const seen: string[] = [];
    const env = {
      AXION_BELIEF_WEBHOOK_URL: "https://hooks.example/axion",
      AXION_WEBHOOK_SECRET: "hook-secret",
      SESSION: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({
          fetch: async () => new Response("nope", { status: 500 }),
        }),
      },
    } as unknown as Env;
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      return new Response("ok", { status: 200 });
    };
    try {
      const out = await runExtraction(env, "s", "I will inspect the logs.", {
        waitUntil: (promise) => {
          void promise;
        },
      });
      expect(out.stored).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

