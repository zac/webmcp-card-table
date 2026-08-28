import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject<Env> {
  async health(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "webmcp-card-table" });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

