#!/usr/bin/env bash
# One-time Cloudflare setup for Kivo, then deploy. Safe to re-run.
#
# Prerequisites:
#   - wrangler authenticated (CLOUDFLARE_API_TOKEN with Workers Scripts, D1, Queues, KV and R2 edit; or `wrangler login`)
#
# File storage: R2 when the account has it enabled (Cloudflare dashboard → R2 → enable; this cannot
# be done by API). When it does not, files are stored in Workers KV instead (indexed in D1), so models
# and videos are still saved. Re-running this script after enabling R2 moves new files to R2 and keeps
# the ones already in KV readable.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
# Runs a create command; "already exists" counts as success. When Cloudflare asks to slow down
# (code 971), waits as long as it says and tries again, up to three times.
ok_if_exists() {
  local attempt wait_s
  for attempt in 1 2 3; do
    if "$@" >"$LOG" 2>&1 || grep -qiE "already exists|already taken|is taken|10004|11009" "$LOG"; then
      tail -n 2 "$LOG"
      return 0
    fi
    if [ "$attempt" -lt 3 ] && grep -qiE "code: 971|throttling your request" "$LOG"; then
      wait_s="$(grep -oiE "wait [0-9]+ second" "$LOG" | grep -oE "[0-9]+" | head -n 1)"
      wait_s="${wait_s:-60}"
      echo "Cloudflare asked to slow down; waiting ${wait_s}s (attempt $attempt of 3)..."
      sleep "$((wait_s + 2))"
      continue
    fi
    cat "$LOG"
    return 1
  done
}

CONFIG="wrangler.jsonc"
FLAGS=""
# KIVO_EMBED_WEB=1 ships the web app inside the Worker script. Use it only where wrangler's
# static-asset upload cannot authenticate (see scripts/make-deploy-config.mjs).
[ "${KIVO_EMBED_WEB:-}" = "1" ] && FLAGS="$FLAGS --embed-web"

# The id of the "kivo-media" KV namespace, or nothing when there is none.
kv_id() {
  npx wrangler kv namespace list --cwd apps/api 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const list = JSON.parse(s.slice(s.indexOf("[")));
        const hit = list.find((n) => n.title === "kivo-media") ?? list.find((n) => String(n.title).endsWith("-kivo-media"));
        if (hit) process.stdout.write(hit.id);
      } catch {}
    });'
}

step "R2 bucket for models and videos (private; never public)"
R2=1
if ! ok_if_exists npx wrangler r2 bucket create kivo-media --cwd apps/api; then
  if grep -qE "10042|enable R2" "$LOG"; then
    echo "!! R2 is not enabled on this Cloudflare account, so files will be stored in Workers KV instead."
    echo "!! To move to R2 later: enable it in the dashboard (R2 → enable) and re-run this script."
    R2=0
    FLAGS="$FLAGS --no-r2"
  else
    exit 1
  fi
fi

KV_ID="$(kv_id)"
if [ "$R2" = "0" ] && [ -z "$KV_ID" ]; then
  step "Workers KV namespace (file storage while R2 is off)"
  ok_if_exists npx wrangler kv namespace create kivo-media --cwd apps/api
  KV_ID="$(kv_id)"
  [ -n "$KV_ID" ] || { echo "Could not create or find the kivo-media KV namespace."; exit 1; }
fi
# An existing namespace stays bound even with R2 on, so files saved in it remain readable.
[ -n "$KV_ID" ] && FLAGS="$FLAGS --kv=$KV_ID"

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
  *--no-r2*) echo "Deployed with Workers KV as file storage (R2 is not enabled). Next: start a render worker (services/renderer/README.md)." ;;
  *) echo "Deployed. Next: start a render worker (services/renderer/README.md) and add the Clerk webhook (docs/DEPLOYMENT.md)." ;;
esac
