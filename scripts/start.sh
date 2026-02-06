#!/bin/bash
# Start the todo dashboard: build if needed, launch ngrok + server, open browser.
# Usage: npm run dashboard  (or: bash scripts/start.sh)

set -e
cd "$(dirname "$0")/.."

# Load port and tunnel URL from .env
PORT=$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 9005)
TUNNEL_URL=$(grep -m1 '^LOCAL_TUNNEL=' .env 2>/dev/null | cut -d= -f2)

# Build if dist/ or ui/dist/ are missing
if [ ! -d dist ] || [ ! -d ui/dist ]; then
  echo "Building..."
  npm run build:all
fi

# Start ngrok in background (uses static domain from .env)
NGROK_PID=""
if [ -n "$TUNNEL_URL" ]; then
  DOMAIN=$(echo "$TUNNEL_URL" | sed 's|https://||')
  echo "Starting ngrok tunnel → $TUNNEL_URL"
  ngrok http "$PORT" --url "$DOMAIN" --log=stdout > /dev/null 2>&1 &
  NGROK_PID=$!
fi

# Start the server
echo "Starting server on port $PORT..."
node dist/index.js &
SERVER_PID=$!

# Clean shutdown on Ctrl+C
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $SERVER_PID 2>/dev/null
  [ -n "$NGROK_PID" ] && kill $NGROK_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM

sleep 2
open "http://localhost:${PORT}"

echo "Dashboard running. Press Ctrl+C to stop."
wait $SERVER_PID
