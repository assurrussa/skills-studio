#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -n "${CODEX_MCP_NODE_PATH:-}" ] && [ -x "$CODEX_MCP_NODE_PATH" ]; then
  exec "$CODEX_MCP_NODE_PATH" ./server.mjs
fi
if [ -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ]; then
  exec /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ./server.mjs
fi
exec node ./server.mjs
