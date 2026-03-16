# SplitCount

Expense splitting via MCP + Claude. Log expenses (including receipt photos), track who paid, and settle up conversationally.

## Architecture

- **MCP server**: Supabase Edge Function (Deno) at `supabase/functions/mcp/`
- **Database**: Supabase PostgreSQL (groups, members, expenses, splits, settlements)
- **Client**: Any MCP-compatible client (Claude Desktop, Claude.ai, etc.)

## Setup

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a new project, and note your:
- Project URL: `https://<ref>.supabase.co`
- Service role key (Settings → API)
- Anon key (Settings → API)

### 2. Run the migration

In the Supabase dashboard → SQL Editor, run the contents of:
```
supabase/migrations/20260315000000_initial_schema.sql
```

Or with the Supabase CLI:
```bash
supabase link --project-ref <your-ref>
supabase db push
```

### 3. Deploy the Edge Function

```bash
supabase functions deploy mcp --no-verify-jwt
```

The `--no-verify-jwt` flag is required since MCP clients don't send Supabase JWTs.

Your MCP server URL will be:
```
https://<your-ref>.supabase.co/functions/v1/mcp
```

### 4. Configure your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "splitcount": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-ref>.supabase.co/functions/v1/mcp"]
    }
  }
}
```

> Uses [`mcp-remote`](https://github.com/geelen/mcp-remote) to bridge HTTP MCP servers to the Claude Desktop stdio transport.

**Claude.ai** (MCP integrations):
Add the server URL directly: `https://<your-ref>.supabase.co/functions/v1/mcp`

## Usage

### Create a group
> "Create a new expense group called 'Barcelona Trip' with my name as Alex"

Claude will return a **6-character join code** (e.g. `XK7M2P`) and your **member_id**. Share the join code with friends.

### Join a group
> "Join group XK7M2P, my name is Jordan"

### Log an expense
> "Log a $45 dinner expense, I paid, split equally among everyone"

**From a receipt photo**: Share the image with Claude, then ask it to log it:
> "Here's my receipt [image]. Add it as an expense split equally."

Claude will read the receipt, extract the amount and description, and call `add_expense` with the details.

### Check balances
> "Who owes what in our group?"

### Settle up
> "Jordan just paid me back $22.50 — record that"

## Identity model

There is no login. When you create or join a group, you receive a **member_id** (UUID). This is your permanent identity — save it. Claude stores it in conversation context and will remind you to note it down.

If you switch devices or start a new conversation, use `get_member` to confirm your identity:
> "My member ID is abc123... — what group am I in?"

## Tools

| Tool | Description |
|------|-------------|
| `create_group` | Create a group, get a join code |
| `join_group` | Join with a join code + display name |
| `get_group` | Group info and member list |
| `add_expense` | Log an expense (equal/exact/percent splits) |
| `list_expenses` | View expenses with split details |
| `delete_expense` | Soft-delete an expense you logged |
| `get_balances` | Net balances + minimum payments to settle |
| `record_settlement` | Record a payment between members |
| `get_settlement_history` | Past settlements |
| `get_member` | Look up your member info |
| `rename_member` | Change your display name |

## Local development

```bash
supabase start          # starts local Postgres + Edge Functions runtime
supabase functions serve mcp --no-verify-jwt
```

Test with curl:
```bash
curl -X POST http://localhost:54321/functions/v1/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
