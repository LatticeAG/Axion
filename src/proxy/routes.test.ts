import { describe, expect, it } from "vitest";
import { handleDashboard, handleLegacyDashboardAsset } from "./routes";
import type { Env } from "./types";

function makeEnv(seen: string[]): Env {
  return {
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        seen.push(new URL(url).pathname);
        return new Response(`asset:${new URL(url).pathname}`, {
          headers: { "Content-Type": "text/html" },
        });
      },
    },
  } as unknown as Env;
}

describe("handleDashboard", () => {
  it("302s /dashboard to /dashboard/", async () => {
    const seen: string[] = [];
    const response = await handleDashboard(
      new Request("https://worker.example/dashboard"),
      makeEnv(seen),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://worker.example/dashboard/",
    );
    expect(seen).toEqual([]);
  });

  it("maps /dashboard/ to /index.html", async () => {
    const seen: string[] = [];
    const response = await handleDashboard(
      new Request("https://worker.example/dashboard/"),
      makeEnv(seen),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(["/index.html"]);
    expect(await response.text()).toBe("asset:/index.html");
  });

  it("maps /dashboard/app.js to /app.js", async () => {
    const seen: string[] = [];
    const response = await handleDashboard(
      new Request("https://worker.example/dashboard/app.js"),
      makeEnv(seen),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(["/app.js"]);
  });

  it("maps /dashboard/vendor/react.production.min.js under ASSETS", async () => {
    const seen: string[] = [];
    await handleDashboard(
      new Request("https://worker.example/dashboard/vendor/react.production.min.js"),
      makeEnv(seen),
    );
    expect(seen).toEqual(["/vendor/react.production.min.js"]);
  });
});

describe("handleLegacyDashboardAsset", () => {
  it("serves origin-root /styles.css and /app.js from ASSETS", async () => {
    const seen: string[] = [];
    const env = makeEnv(seen);
    await handleLegacyDashboardAsset(
      new Request("https://worker.example/styles.css"),
      env,
    );
    await handleLegacyDashboardAsset(
      new Request("https://worker.example/app.js"),
      env,
    );
    expect(seen).toEqual(["/styles.css", "/app.js"]);
  });
});
