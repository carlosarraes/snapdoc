// Artifact serving host: GET /:id and /:id/v/:n; everything else falls
// through to static assets (landing page).
import type { Env } from "./types";

export async function serveArtifactHost(request: Request, env: Env): Promise<Response> {
  return env.ASSETS.fetch(request);
}
