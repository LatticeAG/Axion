/**
 * Axion Lens — Route handlers for non-proxy routes (dashboard + beliefs API).
 */

import type { Env } from "./types";

/**
 * Serve the dashboard. The dashboard is a static asset bound via the ASSETS
 * binding in wrangler.toml. We rewrite `/dashboard` → `/index.html` so the
 * React SPA loads. Sub-paths under /dashboard/ are served as static assets.
 */
export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Root dashboard path → serve index.html from the assets binding.
  if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
    return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  }

  // Sub-paths (e.g. /dashboard/style.css) → strip the prefix and serve the asset.
  const assetPath = url.pathname.replace(/^\/dashboard\/?/, "/");
  const assetUrl = new URL(assetPath || "/index.html", url);
  return env.ASSETS.fetch(new Request(assetUrl, request));
}
