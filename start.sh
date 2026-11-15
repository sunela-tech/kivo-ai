#!/usr/bin/env bash
# INKOS: installs itself on the first run, then opens the app in your browser.
# macOS: double-click start.command instead. Windows: double-click start.bat.
set -e
cd "$(dirname "$0")"

pause() { if [ -t 0 ]; then read -r -p "Press Enter to close this window. " _; fi; }

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "INKOS needs Python 3.10 or newer. Install it from https://www.python.org/downloads/ and run this again."
  pause; exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up INKOS in $(pwd)/.venv"
  echo "This downloads PyTorch and takes a few minutes. Later starts are instant."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  if ! .venv/bin/python -m pip install -r requirements.txt; then
    rm -rf .venv
    echo "Installing the requirements failed (see above). Check your internet connection and run this again."
    pause; exit 1
  fi
fi

echo "Starting INKOS. Leave this window open while you use it; close it to stop INKOS."
exec .venv/bin/python -m inkos serve --open
