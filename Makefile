.PHONY: deploy

# Deploy migrations and edge function.
# Requires SUPABASE_PROJECT_REF to be set (via .envrc + direnv, or exported manually).
deploy:
	./scripts/deploy.sh
