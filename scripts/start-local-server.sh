#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4173}"
HOST="${HOST:-127.0.0.1}"

if python3 - "$PORT" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.4)
result = sock.connect_ex(("127.0.0.1", port))
sock.close()
sys.exit(0 if result == 0 else 1)
PY
then
    echo "Local server already running on http://127.0.0.1:${PORT}"
    exit 0
fi

echo "Starting local server on http://${HOST}:${PORT}"
exec python3 -m http.server "$PORT" --bind "$HOST"
