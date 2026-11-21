#!/bin/sh
# Launcher for the MCP server: GUI hosts start it with a minimal PATH, so look for node in common places.
# Needs Node 22 or newer (node:sqlite); among nvm installs the newest wins, not the first by name.
cd "$(dirname "$0")" || exit 1
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; }
for n in "$BETTER_VIEW_NODE" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
  if ok "$n"; then exec "$n" server.mjs; fi
done
n=$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV | while IFS= read -r c; do if ok "$c"; then echo "$c"; break; fi; done)
if ok "$n"; then exec "$n" server.mjs; fi
echo "[better-view-mcp] Node 22 or newer not found; set BETTER_VIEW_NODE in mcp.json env" >&2
exit 127
