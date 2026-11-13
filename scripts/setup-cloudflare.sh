#!/usr/bin/env bash
# One-time Cloudflare setup for Kivo, then deploy. Safe to re-run.
#
# Prerequisites:
#   - wrangler authenticated (CLOUDFLARE_API_TOKEN with Workers Scripts, D1, Queues and R2 edit; or `wrangler login`)
#   - R2 enabled on the account (Cloudflare dashboard → R2 → enable; this cannot be done by API)
#
# If R2 is not enabled yet, the site is still deployed — without file storage. It then says
# plainly that generation is not available, and re-running this script after enabling R2 fixes it.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
ok_if_exists() { "$@" >"$LOG" 2>&1 || grep -qiE "already exists|already taken|is taken|10004|11009" "$LOG" || { cat "$LOG"; return 1; }; tail -n 2 "$LOG"; }

CONFIG="wrangler.jsonc"
FLAGS=""
# KIVO_EMBED_WEB=1 ships the web app inside the Worker script. Use it only where wrangler's
# static-asset upload cannot authenticate (see scripts/make-deploy-config.mjs).
[ "${KIVO_EMBED_WEB:-}" = "1" ] && FLAGS="$FLAGS --embed-web"

step "R2 bucket for models and videos (private; never public)"
if ! ok_if_exists npx wrangler r2 bucket create kivo-media --cwd apps/api; then
  if grep -qE "10042|enable R2" "$LOG"; then
    echo "!! R2 is not enabled on this Cloudflare account. Enable it in the dashboard (R2 → enable), then re-run this script."
    echo "!! Deploying WITHOUT file storage for now: the site works, but generating videos is refused with a clear message."
    FLAGS="$FLAGS --no-storage"
  else
    exit 1
  fi
fi

step "Queues for the generation pipeline"
ok_if_exists npx wrangler queues create kivo-pipeline --cwd apps/api
ok_if_exists npx wrangler queues create kivo-pipeline-dlq --cwd apps/api

step "D1 schema"
npx wrangler d1 migrations apply kivo --remote --cwd apps/api

step "Build the web app and deploy the Worker"
npm run build -w @kivo/web
if [ -n "$FLAGS" ]; then
  # shellcheck disable=SC2086
  node scripts/make-deploy-config.mjs $FLAGS
  CONFIG="wrangler.generated.jsonc"
fi
npx wrangler deploy --cwd apps/api --config "$CONFIG"

step "Secrets"
scripts/push-secrets.sh

echo
case "$FLAGS" in
  *--no-storage*) echo "Deployed WITHOUT storage. Enable R2 in the Cloudflare dashboard and run this script again to turn generation on." ;;
  *) echo "Deployed. Next: start a render worker (services/renderer/README.md) and add the Clerk webhook (docs/DEPLOYMENT.md)." ;;
esac
