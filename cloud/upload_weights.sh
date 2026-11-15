#!/usr/bin/env bash
# Upload the model files made by build.py, and onnxruntime-web, to the WEIGHTS KV namespace.
#   ./upload_weights.sh            remote (the deployed Worker)
#   ./upload_weights.sh --local    the local `wrangler dev` store
# See upload_files.py: large files are stored in parts, unchanged files are skipped.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 upload_files.py "$@"
