import type { Env } from "./types";

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not implemented", { status: 500 });
  },
} satisfies ExportedHandler<Env>;
