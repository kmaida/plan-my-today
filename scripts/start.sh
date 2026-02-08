#!/bin/bash
# Start the todo dashboard: build if needed, launch server, open browser.
# Usage: npm run dashboard  (or: bash scripts/start.sh)

set -e
cd "$(dirname "$0")/.."

# Load port from .env
PORT=$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 9005)

# Build if dist/ or ui/dist/ are missing
if [ ! -d dist ] || [ ! -d ui/dist ]; then
  echo "Building..."
  npm run build:all
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
  exit 0
}
trap cleanup INT TERM

sleep 2
open "http://localhost:${PORT}"

echo "Dashboard running. Press Ctrl+C to stop."
wait $SERVER_PID
