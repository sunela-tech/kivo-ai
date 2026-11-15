#!/usr/bin/env bash
# Upload the weights made by build.py to the WEIGHTS KV namespace.
#   ./upload_weights.sh            remote (the deployed Worker)
#   ./upload_weights.sh --local    the local `wrangler dev` store
set -euo pipefail
cd "$(dirname "$0")"
where="${1:---remote}"
for f in public/weights/*.json public/weights/*.bin; do
  key="weights/$(basename "$f")"
  size=$(wc -c < "$f" | tr -d ' ')
  echo "uploading $key ($size bytes)"
  npx wrangler kv key put "$key" --path "$f" --binding WEIGHTS --metadata "{\"size\":$size}" "$where" >/dev/null
done
