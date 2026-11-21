// The panel as one self-contained HTML document: index.html with style.css and app.js inlined.
// Both embedded hosts need this: an MCP App frame has no network at all, and the sidecar gateway only
// lets through requests that carry the host's token (the iframe URL has it; relative style.css/app.js
// requests would not, and the gateway answers them 401). `bridge` adds the MCP Apps postMessage bridge.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

export function inlinePage({ bridge = false, uiDir = UI_DIR } = {}) {
  const read = (f) => readFileSync(join(uiDir, f), 'utf8');
  const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
  const scripts = (bridge ? `<script>\n${safe(read('mcp-bridge.js'))}\n</script>\n` : '') + `<script type="module">\n${safe(read('app.js'))}\n</script>`;
  return read('index.html')
    .replace(/<link rel="stylesheet" href="style.css">/, () => `<style>\n${read('style.css')}\n</style>`)
    .replace(/<script src="app.js" type="module"><\/script>/, () => scripts);
}
