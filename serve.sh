#!/usr/bin/env bash
# Serve the Fleet Command '99 web build on the local network.
# Open the printed URL in any browser (Mac Safari/Chrome, or iPhone on the same Wi-Fi).
set -e
PORT="${1:-8000}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Fleet Command '99 → http://localhost:${PORT}/"
echo "(On your iPhone, use http://<this-Mac's-LAN-IP>:${PORT}/ — both devices must be on the same Wi-Fi.)"
cd "$DIR"
exec python3 -m http.server "$PORT"
