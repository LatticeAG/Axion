import { describe, expect, it } from "vitest";
import { fetchHealth, fetchReady } from "./health";
import type { Env } from "./types";

function makeEnv(registryOk = true): Env {
  return {
    AXION_READ_TOKEN: "test-read-token",
    SESSION: {} as DurableObjectNamespace,
    SESSION_REGISTRY: {
      idFromName: () => "registry" as unknown as DurableObjectId,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ sessions: [] }), {
            status: registryOk ? 200 : 500,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    },
    ASSETS: { fetch: async () => new Response("ok") },
  } as unknown as Env;
}

describe("GET /api/health", () => {
  it("is 200 without a token and does not touch Durable Objects", async () => {
    const env = makeEnv();
    const response = fetchHealth(new Request("https://worker.example/api/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: "axion",
      version: "0.1.0",
    });
  });
});

describe("GET /api/ready", () => {
  it("requires a read token", async () => {
    const response = await fetchReady(
      new Request("https://worker.example/api/ready"),
      makeEnv(),
    );
    expect(response.status).toBe(401);
  });

  it("reports registry up when the ping succeeds", async () => {
    const response = await fetchReady(
      new Request("https://worker.example/api/ready", {
        headers: { "x-axion-read-token": "test-read-token" },
      }),
      makeEnv(true),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, registry: "up" });
  });

  it("reports registry down when the ping fails", async () => {
    const response = await fetchReady(
      new Request("https://worker.example/api/ready", {
        headers: { "x-axion-read-token": "test-read-token" },
      }),
      makeEnv(false),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, registry: "down" });
  });
});
