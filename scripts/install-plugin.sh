#!/bin/sh
# Installs/updates Better View as an Antigravity plugin in ~/.gemini/config/plugins/better-view: an MCP App
# (opens in Antigravity's side pane from its "+" menu / Overview ▸ Extensions) plus a sidecar kept disabled,
# because sidecar UIs need the server-side `enable-ui-sidecars` experiment.
# Usage: scripts/install-plugin.sh            stage, validate with `agy plugin validate --strict`, then install
#        scripts/install-plugin.sh --check    stage and validate only
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.gemini/config/plugins/better-view"
STAGE="$ROOT/build/plugin/better-view"
AGY="${AGY:-}"
for c in "$AGY" "$(command -v agy 2>/dev/null || true)" /Applications/Antigravity.app/Contents/Helpers/agy /Applications/Antigravity.app/Contents/Resources/bin/agy /Applications/Gemini.app/Contents/Helpers/agy; do
  if [ -n "$c" ] && [ -x "$c" ]; then AGY="$c"; break; fi
done

rm -rf "$STAGE"
mkdir -p "$STAGE/sidecars/panel"
cp "$ROOT/plugin.json" "$ROOT/LICENSE" "$STAGE/"
cp -R "$ROOT/assets" "$STAGE/"
for f in sidecar.json run.sh server.mjs lib ui; do cp -R "$ROOT/sidecars/panel/$f" "$STAGE/sidecars/panel/"; done
chmod +x "$STAGE/sidecars/panel/run.sh"
# the MCP App (side pane / sidebar entry inside Antigravity) shares lib/ and ui/ with the sidecar
mkdir -p "$STAGE/mcp"
cp "$ROOT/mcp/server.mjs" "$ROOT/mcp/run.sh" "$STAGE/mcp/"
chmod +x "$STAGE/mcp/run.sh"
# both: mcp.json under the Agent Plugins spec flag, mcp_config.json for native loading (each mode ignores the other)
cp "$ROOT/mcp.json" "$ROOT/mcp_config.json" "$STAGE/"
# the always-on rule: plan a task list (task.md) before multi-step work, so the panel can show it
mkdir -p "$STAGE/rules" && cp "$ROOT/rules/AGENTS.md" "$STAGE/rules/"

if [ -n "$AGY" ]; then
  "$AGY" plugin validate "$STAGE" --strict
else
  echo "找不到 agy，跳过校验" >&2
fi
[ "${1:-}" = "--check" ] && exit 0

mkdir -p "$DEST"
# replace the plugin's files; keep anything the host keeps inside the folder (logs/, data)
rsync -a --delete --exclude logs/ --exclude data/ "$STAGE/" "$DEST/"
echo "已更新插件：$DEST（版本 $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/plugin.json")）"
