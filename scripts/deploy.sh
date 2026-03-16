#!/usr/bin/env bash
set -euo pipefail

# Deploy SplitCount to Supabase.
# Reads SUPABASE_PROJECT_REF from the environment (set it in .envrc).
# Usage: ./scripts/deploy.sh

if ! command -v supabase &>/dev/null; then
  echo "Error: supabase CLI not found."
  echo "Install it: https://supabase.com/docs/guides/cli/getting-started"
  exit 1
fi

if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
  echo "Error: SUPABASE_PROJECT_REF is not set."
  echo "Add it to .envrc:  export SUPABASE_PROJECT_REF=<your-ref>"
  exit 1
fi

echo "Linking to project: $SUPABASE_PROJECT_REF"
supabase link --project-ref "$SUPABASE_PROJECT_REF"

echo "Pushing database migrations..."
supabase db push

echo "Reloading PostgREST schema cache..."
supabase db execute --sql "SELECT pg_notify('pgrst', 'reload schema');" 2>/dev/null \
  || echo "  (schema cache reload skipped — run manually in SQL Editor if queries fail: SELECT pg_notify('pgrst', 'reload schema');)"

echo "Deploying mcp edge function..."
supabase functions deploy mcp --no-verify-jwt

echo "Deploying proxy worker..."
cd proxy && npx wrangler deploy && cd ..

echo ""
echo "Deploy complete."
echo "Direct Supabase URL (API calls): https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/mcp"
echo "Connector URL (Claude Desktop/web/mobile): see worker URL printed by wrangler above"
