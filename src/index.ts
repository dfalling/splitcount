import postgres from "postgres";
import { handleToolCall } from "./handlers";
import { runMigrations } from "./migrate";
import { TOOLS } from "./tools";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[splitcount] DATABASE_URL environment variable is required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

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

await runMigrations(sql);

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`[splitcount] listening on port ${port}`);

Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.has("health")) {
        return jsonResponse({ name: "splitcount", status: "ok" });
      }
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

    if (method.startsWith("notifications/")) {
      return new Response(null, { status: 202, headers: CORS });
    }

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
          const result = await handleToolCall(sql, toolName, toolArgs ?? {});
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
  },
});
