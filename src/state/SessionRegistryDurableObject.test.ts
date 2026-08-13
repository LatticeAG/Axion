import { describe, expect, it } from "vitest";
import {
  extractPathSessionId,
  SessionRegistryDurableObject,
} from "./SessionRegistryDurableObject";
import type { SessionMetadata } from "./sessionRegistry";

function makeState(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
}

function registration(
  id: string,
  updatedAt: number,
  overrides: Record<string, unknown> = {},
): Request {
  return new Request("https://internal/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      createdAt: updatedAt - 1,
      updatedAt,
      modelName: "gpt-4.1-mini",
      provider: "openai",
      sessionName: `Run ${id}`,
      messageCount: 1,
      tokenUsage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      ...overrides,
    }),
  });
}

describe("SessionRegistryDurableObject", () => {
  it("registers a session with every required metadata field", async () => {
    const registry = new SessionRegistryDurableObject(makeState());
    const response = await registry.fetch(registration("session-a", 100));
    const body = (await response.json()) as { created: boolean; session: SessionMetadata };

    expect(response.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.session).toEqual({
      id: "session-a",
      createdAt: 99,
      updatedAt: 100,
      modelName: "gpt-4.1-mini",
      provider: "openai",
      sessionName: "Run session-a",
      messageCount: 1,
      tokenUsage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  });

  it("idempotently upserts an existing session snapshot", async () => {
    const registry = new SessionRegistryDurableObject(makeState());
    await registry.fetch(registration("session-a", 100));
    const response = await registry.fetch(
      registration("session-a", 200, {
        messageCount: 2,
        tokenUsage: {
          prompt_tokens: 20,
          completion_tokens: 12,
          total_tokens: 32,
        },
      }),
    );
    const body = (await response.json()) as { created: boolean; session: SessionMetadata };

    expect(response.status).toBe(200);
    expect(body.created).toBe(false);
    expect(body.session.createdAt).toBe(99);
    expect(body.session.updatedAt).toBe(200);
    expect(body.session.messageCount).toBe(2);
    expect(body.session.tokenUsage.total_tokens).toBe(32);
  });

  it("lists sessions newest first in default 20-item cursor pages", async () => {
    const registry = new SessionRegistryDurableObject(makeState());
    for (let index = 0; index < 23; index++) {
      await registry.fetch(registration(`session-${index}`, index));
    }

    const firstResponse = await registry.fetch(
      new Request("https://internal/sessions"),
    );
    const first = (await firstResponse.json()) as {
      sessions: SessionMetadata[];
      nextCursor: string | null;
    };
    expect(first.sessions).toHaveLength(20);
    expect(first.sessions[0]?.id).toBe("session-22");
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await registry.fetch(
      new Request(
        `https://internal/sessions?cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
    );
    const second = (await secondResponse.json()) as {
      sessions: SessionMetadata[];
      nextCursor: string | null;
    };
    expect(second.sessions).toHaveLength(3);
    expect(second.sessions.map((item) => item.id)).toEqual([
      "session-2",
      "session-1",
      "session-0",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("honours a bounded internal list limit for search and health consumers", async () => {
    const registry = new SessionRegistryDurableObject(makeState());
    await registry.fetch(registration("a", 1));
    await registry.fetch(registration("b", 2));
    await registry.fetch(registration("c", 3));

    const response = await registry.fetch(new Request("https://internal/sessions?limit=2"));
    const page = (await response.json()) as {
      sessions: SessionMetadata[];
      nextCursor: string | null;
    };

    expect(page.sessions.map((item) => item.id)).toEqual(["c", "b"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("returns an individual record from an encoded session path", async () => {
    const registry = new SessionRegistryDurableObject(makeState());
    await registry.fetch(registration("run/with spaces", 10));

    const response = await registry.fetch(
      new Request("https://internal/session/run%2Fwith%20spaces"),
    );
    const body = (await response.json()) as SessionMetadata;

    expect(response.status).toBe(200);
    expect(body.id).toBe("run/with spaces");
  });

  it("returns JSON errors for bad payloads, missing records, and unknown routes", async () => {
    const registry = new SessionRegistryDurableObject(makeState());
    const badPayload = await registry.fetch(
      new Request("https://internal/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    const missing = await registry.fetch(new Request("https://internal/session/nope"));
    const unknown = await registry.fetch(new Request("https://internal/unknown"));

    expect(badPayload.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await missing.json()) as unknown).toEqual({
      error: { message: "Session not found" },
    });
  });

  it("normalizes malformed legacy storage instead of throwing", async () => {
    const registry = new SessionRegistryDurableObject(
      makeState({ sessions: [null, { id: "valid", updatedAt: 2 }] }),
    );

    const response = await registry.fetch(new Request("https://internal/sessions"));
    const body = (await response.json()) as { sessions: SessionMetadata[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id: "valid", modelName: "unknown" });
  });
});

describe("extractPathSessionId", () => {
  it("accepts exactly one encoded path segment", () => {
    expect(extractPathSessionId("/session/a%2Fb")).toBe("a/b");
    expect(extractPathSessionId("/session/a/b")).toBeNull();
    expect(extractPathSessionId("/session/")).toBeNull();
    expect(extractPathSessionId("/other/a")).toBeNull();
  });
});
