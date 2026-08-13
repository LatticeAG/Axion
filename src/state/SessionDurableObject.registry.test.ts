import { describe, expect, it } from "vitest";
import { SessionDurableObject } from "./SessionDurableObject";
import { SESSION_REGISTRY_INSTANCE_NAME } from "./sessionRegistry";
import type { ExtractedBelief } from "../lens/types";
import type { Env, ExtractionResult } from "../proxy/types";

function makeState() {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
}

function belief(id: string): ExtractedBelief {
  return {
    id,
    sessionId: "session-a",
    type: "causal",
    belief: "the deploy stalled",
    confidence: 0.7,
    timestamp: 1,
    rawText: "because of the outage",
    line: 1,
  };
}

function post(result: ExtractionResult): Request {
  return new Request("https://internal/store-beliefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
}

function extractionResult(
  timestamp: number,
  overrides: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    sessionId: "session-a",
    beliefs: [belief(`belief-${timestamp}`)],
    rawText: "Because of the outage the deploy stalled.",
    timestamp,
    modelName: "gpt-4.1-mini",
    provider: "openai",
    // This deliberately models an inbound history length; the registry must
    // use stored batch count instead.
    messageCount: 99,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };
}

describe("SessionDurableObject registry integration", () => {
  it("registers the first write and upserts cumulative session metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const names: string[] = [];
    const registryStub = {
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      },
    } as unknown as DurableObjectStub;
    const env = {
      SESSION_REGISTRY: {
        idFromName: (name: string) => {
          names.push(name);
          return {} as DurableObjectId;
        },
        get: () => registryStub,
      } as unknown as DurableObjectNamespace,
    } as Env;
    const session = new SessionDurableObject(makeState(), env);

    const firstResponse = await session.fetch(post(extractionResult(100)));
    const secondResponse = await session.fetch(
      post(
        extractionResult(200, {
          usage: {
            prompt_tokens: 7,
            completion_tokens: 11,
            total_tokens: 18,
          },
          // The current inbound messages can shrink or grow; registry count
          // remains one row per persisted model response.
          messageCount: 1,
        }),
      ),
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(names).toEqual([
      SESSION_REGISTRY_INSTANCE_NAME,
      SESSION_REGISTRY_INSTANCE_NAME,
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://internal/register");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      id: "session-a",
      sessionName: "session-a",
      createdAt: 100,
      updatedAt: 100,
      modelName: "gpt-4.1-mini",
      provider: "openai",
      messageCount: 1,
      tokenUsage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      id: "session-a",
      createdAt: 100,
      updatedAt: 200,
      messageCount: 2,
      tokenUsage: {
        prompt_tokens: 17,
        completion_tokens: 16,
        total_tokens: 33,
      },
    });
  });

  it("keeps the timeline write successful when registry registration fails", async () => {
    const registryStub = {
      fetch: async () => new Response("registry error", { status: 500 }),
    } as unknown as DurableObjectStub;
    const env = {
      SESSION_REGISTRY: {
        idFromName: () => ({} as DurableObjectId),
        get: () => registryStub,
      } as unknown as DurableObjectNamespace,
    } as Env;
    const session = new SessionDurableObject(makeState(), env);

    const write = await session.fetch(post(extractionResult(100)));
    const beliefs = await session.fetch(new Request("https://internal/beliefs"));

    expect(write.status).toBe(200);
    expect((await beliefs.json()) as unknown).toMatchObject({
      sessionId: "session-a",
      beliefs: [{ id: "belief-100" }],
    });
  });
});
