import { routeAgentRequest } from "agents";
import { LolAgent } from "./agent";

export { LolAgent };

export default {
  async fetch(request: Request, env: any, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route API calls to the Agent (Durable Object)
    if (url.pathname.startsWith("/api/")) {
      const response = await routeAgentRequest(request, env, "LOL_AGENT");
      if (response) return response;
      return new Response("Not found", { status: 404 });
    }

    // Everything else → serve static assets from ./public
    return env.ASSETS.fetch(request);
  },
};
