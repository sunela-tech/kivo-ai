#!/usr/bin/env bash
# One-time Cloudflare setup for Kivo, then deploy. Safe to re-run.
#
# Prerequisites:
#   - wrangler authenticated (CLOUDFLARE_API_TOKEN with Workers Scripts, D1, Queues and R2 edit; or `wrangler login`)
#   - R2 enabled on the account (Cloudflare dashboard → R2 → enable; this cannot be done by API)
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }
ok_if_exists() { "$@" 2>&1 | tee /tmp/kivo-setup.log || grep -qiE "already exists|already taken|10004|11009" /tmp/kivo-setup.log; }

step "R2 bucket for models and videos (private; never public)"
ok_if_exists npx wrangler r2 bucket create kivo-media --cwd apps/api

step "Queues for the generation pipeline"
ok_if_exists npx wrangler queues create kivo-pipeline --cwd apps/api
ok_if_exists npx wrangler queues create kivo-pipeline-dlq --cwd apps/api

step "D1 schema"
npx wrangler d1 migrations apply kivo --remote --cwd apps/api

step "Build the web app and deploy the Worker"
npm run build -w @kivo/web
npx wrangler deploy --cwd apps/api

step "Secrets"
scripts/push-secrets.sh

echo
echo "Deployed. Next: start a render worker (services/renderer/README.md) and add the Clerk webhook (docs/DEPLOYMENT.md)."
