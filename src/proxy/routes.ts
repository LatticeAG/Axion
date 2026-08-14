/**
 * Axion Lens - Route handlers for dashboard static assets.
 */

import type { Env } from "./types";

/**
 * Serve the dashboard. `/dashboard` redirects to `/dashboard/` so relative
 * `styles.css` / `app.js` resolve under `/dashboard/`. Sub-paths strip the
 * prefix and fetch from the ASSETS binding.
 */
export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/dashboard") {
    return Response.redirect(new URL("/dashboard/", url).toString(), 302);
  }

  if (url.pathname === "/dashboard/") {
    return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  }

  const assetPath = url.pathname.replace(/^\/dashboard\/?/, "/");
  const assetUrl = new URL(assetPath || "/index.html", url);
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

/**
 * Compatibility aliases for one release: origin-root `/styles.css` and `/app.js`
 * used to work when Wrangler served assets before the Worker. With
 * run_worker_first they would 404 unless we map them onto ASSETS.
 */
export async function handleLegacyDashboardAsset(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/styles.css" || url.pathname === "/app.js") {
    return env.ASSETS.fetch(new Request(new URL(url.pathname, url), request));
  }
  return new Response("Not Found", { status: 404 });
}
