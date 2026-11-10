// Builds a single self-contained HTML file of the editor for the web (lyrics.smegolas.com).
// Usage: node scripts/build-web.mjs [out.html]
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.argv[2] || 'dist/lrcssync-web.html';
// Optional: LRCSSYNC_GENIUS_PROXY=/genius bakes in the address of a Genius relay run by the hosting site.
const geniusProxy = process.env.LRCSSYNC_GENIUS_PROXY || '';
const version = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version.replace(/\.0$/, '');
const js = (await build({ entryPoints: ['ui/js/app.js'], bundle: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' })).outputFiles[0].text;
const css = readFileSync('ui/style.css', 'utf8');
const icon = 'data:image/png;base64,' + readFileSync('ui/icon.png').toString('base64');
let html = readFileSync('ui/index.html', 'utf8');

html = html
  .replace('<link rel="stylesheet" href="style.css">', `<link rel="icon" href="${icon}">\n  <style>\n${css}\n  </style>`)
  .replace(/src="icon\.png"/g, `src="${icon}"`)
  .replace('<script type="module" src="js/app.js"></script>', () => `<script>window.LRCSSYNC_WEB_VERSION = ${JSON.stringify(version)};${geniusProxy ? ` window.LRCSSYNC_GENIUS_PROXY = ${JSON.stringify(geniusProxy)};` : ''}</script>\n  <script>\n${js.replace(/<\/script/gi, '<\\/script')}\n  </script>`);

const header = `<!--
  LRCSSync ${version} (web build) - lyrics timing editor
  Source: https://github.com/Smegoligga/LRCSSync  (built by scripts/build-web.mjs, do not edit by hand)

  Everything is in this one file. To host it, serve it as index.html (e.g. at lyrics.smegolas.com).
  It runs fully in the browser: audio is analysed locally and never uploaded. LRCLIB search uses
  https://lrclib.net from the browser. Embedding lyrics into song files needs the desktop/Android app.

  Genius: browsers don't let a web page read genius.com, so Genius search only works when the hosting site
  relays it. Build with LRCSSYNC_GENIUS_PROXY=/genius (or set window.LRCSSYNC_GENIUS_PROXY before this script)
  and make the server pass GET /genius/api/search/multi and /genius/<song>-lyrics on to https://genius.com.

  Speech recognition downloads its engine from cdn.jsdelivr.net and the model from huggingface.co. A strict
  Content-Security-Policy has to allow those (script-src: cdn.jsdelivr.net 'wasm-unsafe-eval' blob:;
  connect-src: cdn.jsdelivr.net huggingface.co *.huggingface.co *.hf.co). Sending
  Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless makes it much faster.

  Accounts: the page has an empty <div id="account"> slot in the header. A site wrapper can fill it
  (e.g. "Signed in as X / Log out") and/or set window.LRCSSYNC_USER = { name } before this script runs.
-->
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, header + html);
console.log(`wrote ${out} (${(Buffer.byteLength(header + html) / 1024).toFixed(0)} KB)`);
