import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { TOOLS } from "./tools.ts";
import { handleToolCall } from "./handlers.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-client-info, apikey, MCP-Protocol-Version",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function rpcOk(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcErr(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method === "GET") {
    // Health check probe — return 200 only when explicitly requested
    const url = new URL(req.url);
    if (url.searchParams.has("health")) {
      return jsonResponse({ name: "splitcount", status: "ok" });
    }
    // Streamable HTTP spec: GET without SSE support → 405
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS, Allow: "POST" },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcErr(null, -32700, "Parse error: invalid JSON");
  }

  const rpc = body as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: unknown;
  };

  if (rpc.jsonrpc !== "2.0" || !rpc.method) {
    return rpcErr(rpc.id ?? null, -32600, "Invalid Request");
  }

  const { id, method, params } = rpc;

  // Notifications — spec requires 202 Accepted
  if (method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: CORS });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (method) {
      case "initialize":
        return rpcOk(id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "splitcount", version: "1.0.0" },
          instructions:
            "SplitCount helps groups track and split shared expenses. " +
            "When a user wants to join a group, call join_group without a display_name first so they can pick who they are from the existing member list. " +
            "To log an expense from a receipt photo, read the image yourself to extract the amount, merchant, and items, " +
            "then call add_expense with the details and a receipt_note summarizing what you saw. " +
            "Use get_balances to see who owes whom, and record_settlement when someone pays another person back.",
        });

      case "tools/list":
        return rpcOk(id, { tools: TOOLS });

      case "tools/call": {
        const { name: toolName, arguments: toolArgs } = params as {
          name: string;
          arguments: Record<string, unknown>;
        };
        const result = await handleToolCall(db, toolName, toolArgs ?? {});
        return rpcOk(id, result);
      }

      default:
        return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    console.error(`[splitcount] error in ${method}:`, e);
    return rpcErr(id, -32603, msg);
  }
});
