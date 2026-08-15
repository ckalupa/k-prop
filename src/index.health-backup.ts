interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const databaseCheck = await env.DB
        .prepare("SELECT 1 AS connected")
        .first<{ connected: number }>();

      return Response.json({
        application: "mlb-k-prop-api",
        status: "ok",
        databaseConnected: databaseCheck?.connected === 1,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "Not found",
          path: url.pathname,
        },
        { status: 404 },
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;