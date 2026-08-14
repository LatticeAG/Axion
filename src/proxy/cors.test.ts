import { describe, expect, it } from "vitest";
import { applyCors, corsAllowOrigin, handleApiOptions } from "./cors";
import type { Env } from "./types";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SESSION: {} as DurableObjectNamespace,
    SESSION_REGISTRY: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
    ...overrides,
  };
}

describe("CORS policy", () => {
  it("omits ACAO when AXION_CORS_ORIGIN is unset", () => {
    const request = new Request("https://worker.example/api/sessions", {
      headers: { Origin: "https://evil.example" },
    });
    expect(corsAllowOrigin(request, env())).toBeNull();
    const headers = new Headers({ "Access-Control-Allow-Origin": "*" });
    applyCors(request, env(), headers);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("reflects Origin only on an exact match", () => {
    const allowed = env({ AXION_CORS_ORIGIN: "https://app.example" });
    const match = new Request("https://worker.example/api/sessions", {
      headers: { Origin: "https://app.example" },
    });
    const mismatch = new Request("https://worker.example/api/sessions", {
      headers: { Origin: "https://other.example" },
    });
    expect(corsAllowOrigin(match, allowed)).toBe("https://app.example");
    expect(corsAllowOrigin(mismatch, allowed)).toBeNull();
  });

  it("handles OPTIONS /api/* with 204 and the locked header set", () => {
    const request = new Request("https://worker.example/api/sessions", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" },
    });
    const response = handleApiOptions(
      request,
      env({ AXION_CORS_ORIGIN: "https://app.example" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, x-axion-read-token, x-axion-session",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe("600");
  });
});
