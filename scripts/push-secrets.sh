#!/usr/bin/env bash
# Upload Kivo's secrets to the deployed Worker.
#
# Reads apps/api/.dev.vars (gitignored) and stores each secret with
# `wrangler secret bulk`. Values are never printed and never written to the repo.
#
#   scripts/push-secrets.sh
#
# Requires Cloudflare credentials for wrangler (CLOUDFLARE_API_TOKEN, or `wrangler login`).
set -euo pipefail

cd "$(dirname "$0")/../apps/api"
SOURCE="${1:-.dev.vars}"
[ -f "$SOURCE" ] || { echo "No $SOURCE found. Copy .dev.vars.example to .dev.vars and fill it in."; exit 1; }

SECRETS="GEMINI_API_KEY MESHY_API_KEY CLERK_SECRET_KEY CLERK_WEBHOOK_SECRET RENDER_SERVICE_TOKEN SIGNING_SECRET"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

python3 - "$SOURCE" "$TMP" $SECRETS <<'PY'
import json, re, sys
source, out, wanted = sys.argv[1], sys.argv[2], sys.argv[3:]
values = {}
for line in open(source, encoding="utf-8"):
    m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$', line)
    if m and m.group(1) in wanted and m.group(2):
        values[m.group(1)] = m.group(2)
json.dump(values, open(out, "w"))
missing = [k for k in wanted if k not in values]
print("Uploading:", ", ".join(sorted(values)) or "(nothing)")
if missing:
    print("Not set in", source + ":", ", ".join(missing))
PY

npx wrangler secret bulk "$TMP"
echo "Done. Check which integrations are configured: curl https://<your-worker>/api/health"
