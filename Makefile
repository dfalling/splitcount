.PHONY: deploy deploy-proxy

# Deploy migrations, edge function, and proxy worker.
# Requires SUPABASE_PROJECT_REF to be set (via .envrc + direnv, or exported manually).
deploy:
	./scripts/deploy.sh

# Deploy only the Cloudflare Worker proxy.
deploy-proxy:
	cd proxy && npx wrangler deploy
