const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-client-info, apikey, MCP-Protocol-Version",
};

interface Env {
  UPSTREAM: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Tell Claude "no auth needed" — Supabase would return 401 here
    if (url.pathname.startsWith("/.well-known/")) {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Proxy everything else to Supabase
    const upstream = new Request(env.UPSTREAM, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    const res = await fetch(upstream);
    const resHeaders = new Headers(res.headers);
    Object.entries(CORS).forEach(([k, v]) => resHeaders.set(k, v));
    return new Response(res.body, { status: res.status, headers: resHeaders });
  },
};
