import { Hono } from "hono";
import { createPublisherApp, mapStoreError } from "./api";
import { serveArtifactHost } from "./serve";
import { Store } from "./store";
import { errorResponse } from "./http";
import type { Env } from "./types";

const apiApp = new Hono<{ Bindings: Env }>();
apiApp.route("/v1", createPublisherApp());
apiApp.onError((err) => mapStoreError(err));
apiApp.notFound((c) => {
  if (c.req.path.startsWith("/v1/")) {
    return errorResponse("not_found", "Unknown API route.");
  }
  // Dashboard and other static assets on the API host.
  return c.env.ASSETS.fetch(c.req.raw);
});

function isApiRequest(url: URL, env: Env): boolean {
  if (url.hostname === env.API_HOST) return true;
  if (url.hostname === env.ARTIFACT_HOST) return false;
  // wrangler dev fallback (single localhost host): route by path.
  return url.pathname.startsWith("/v1/") || url.pathname === "/admin" || url.pathname.startsWith("/admin/");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isApiRequest(url, env)) return apiApp.fetch(request, env, ctx);
    return serveArtifactHost(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await new Store(env.DB, env.BLOBS).cleanupExpired();
  },
} satisfies ExportedHandler<Env>;
