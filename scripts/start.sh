#!/bin/bash
# Start Plan My Today: build if needed, launch server, open app.
# Usage: npm run plan-my-today  (or: bash scripts/start.sh)

set -e
cd "$(dirname "$0")/.."

# Ensure node/npm are on PATH when launched outside a login shell (e.g., Dock, Finder)
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:$PATH"

# Load port from .env
PORT=$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 9005)

echo "Building..."
npm run build:all

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
# Open installed PWA if available, otherwise fall back to browser
open -a "Plan My Today" 2>/dev/null || open "http://localhost:${PORT}"

echo "Plan My Today running. Press Ctrl+C to stop."

# Minimize the Terminal window so it stays available but out of the way
osascript -e 'tell application "Terminal" to set miniaturized of front window to true' 2>/dev/null

wait $SERVER_PID
