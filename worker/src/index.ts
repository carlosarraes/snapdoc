import { Hono } from "hono";
import { createPublisherApp, mapStoreError } from "./api";
import { createAdminApp } from "./admin-api";
import { createReaderApp } from "./reader-api";
import { serveReviewPage } from "./review";
import { fetchStaticAsset, serveArtifactHost } from "./serve";
import { Store } from "./store";
import { errorResponse } from "./http";
import type { Env } from "./types";

const apiApp = new Hono<{ Bindings: Env }>();
apiApp.route("/v1/admin", createAdminApp());
// Public, unauthenticated — must be mounted before the Bearer-gated /v1 app.
apiApp.route("/v1/reader", createReaderApp());
apiApp.route("/v1", createPublisherApp());
// Public review page; its :id handler falls through to static bundle files.
apiApp.get("/review/:id", serveReviewPage);
apiApp.onError((err) => mapStoreError(err));
apiApp.notFound((c) => {
  if (c.req.path.startsWith("/v1/")) {
    return errorResponse("not_found", "Unknown API route.");
  }
  // Dashboard and other static assets on the API host.
  return fetchStaticAsset(c.req.raw, c.env);
});

function isApiRequest(url: URL, env: Env): boolean {
  if (url.hostname === env.API_HOST) return true;
  if (url.hostname === env.ARTIFACT_HOST) return false;
  // wrangler dev fallback (single localhost host): route by path.
  return (
    url.pathname.startsWith("/v1/") ||
    url.pathname === "/admin" ||
    url.pathname.startsWith("/admin/") ||
    url.pathname === "/review" ||
    url.pathname.startsWith("/review/")
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isApiRequest(url, env)) return apiApp.fetch(request, env, ctx);
    return serveArtifactHost(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB, env.BLOBS);
    await store.cleanupExpired();
    await store.auditOrphanVideoBlobs();
  },
} satisfies ExportedHandler<Env>;
