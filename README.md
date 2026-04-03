# SplitCount

Expense splitting via MCP + Claude. Log expenses (including receipt photos), track who paid, and settle up conversationally.

## Architecture

- **MCP server**: Bun HTTP server at `src/`
- **Database**: PostgreSQL (self-hosted or any provider)
- **Client**: Any MCP-compatible client (Claude Desktop, Claude.ai, etc.)

Migrations run automatically on startup. No migration tooling required.

## Self-hosting with Docker

The easiest way to run SplitCount is with Docker Compose. Add it to your existing stack:

```yaml
services:
  splitcount:
    image: ghcr.io/dfalling/splitcount:latest
    environment:
      DATABASE_URL: postgres://user:password@your-postgres-host:5432/splitcount
    ports:
      - "3000:3000"
    restart: unless-stopped
```

The server will be available at `http://your-server:3000`.

### Connect to Claude

In Claude Desktop or Claude.ai settings, add a custom MCP connector:
```
http://your-server:3000
```

## Local development

**Prerequisites**: [mise](https://mise.jdx.dev/) for version management.

```bash
mise install          # installs bun
bun install           # install dependencies
cp .envrc.example .envrc
# edit .envrc with your DATABASE_URL
bun run dev           # start with hot reload
```

Test the server:
```bash
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Health check:
```bash
curl http://localhost:3000?health
```

## Usage

### Create a group
> "Create a new expense group called 'Barcelona Trip' with my name as Alex"

Claude returns a **6-character join code** (e.g. `XK7M2P`) and your **member_id**. Share the join code with friends.

### Join a group
> "Join group XK7M2P"

Claude will show you the existing member list so you can claim your slot or join as someone new.

### Log an expense
> "Log a $45 dinner expense, I paid, split equally among everyone"

**From a receipt photo**: share the image with Claude, then ask it to log it:
> "Here's my receipt [image]. Add it as an expense split equally."

Claude reads the receipt, extracts the amount and description, and calls `add_expense`.

### Check balances
> "Who owes what in our group?"

### Settle up
> "Jordan just paid me back $22.50 — record that"

## Identity model

There is no login. When you create or join a group you receive a **member_id** (UUID). This is your permanent identity — save it. Claude stores it in conversation context and will remind you to note it down.

If you start a new conversation, use `get_member` to confirm your identity:
> "My member ID is abc123... — what group am I in?"

## Tools

| Tool | Description |
|------|-------------|
| `create_group` | Create a group, get a join code |
| `join_group` | Join with a join code; shows member list to claim or create |
| `get_group` | Group info and member list |
| `add_expense` | Log an expense (equal/exact/percent splits) |
| `list_expenses` | View expenses with split details |
| `update_expense` | Edit an expense you logged |
| `delete_expense` | Soft-delete an expense you logged |
| `get_balances` | Net balances + minimum payments to settle |
| `record_settlement` | Record a payment between members |
| `get_settlement_history` | Past settlements |
| `add_member` | Pre-add a member before they join |
| `claim_member` | Identify as an existing member |
| `list_members` | List all members in a group |
| `get_member` | Look up your member info |
| `rename_member` | Change your display name |

## Database migrations

Migrations live in `migrations/` and are applied automatically at startup in order. To add a new migration, create a file named `NNN_description.sql` (e.g. `005_add_tags.sql`).
