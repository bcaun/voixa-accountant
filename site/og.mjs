// Renders the link preview image (site/src/og.png, 1200×630) from the brand's own elements.
// Needs Playwright; run once when the design changes: node site/og.mjs
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright/index.js'); }
const here = path.dirname(fileURLToPath(import.meta.url));
const font = async (f) => `data:font/woff2;base64,${(await readFile(path.join(here, 'src/fonts', f))).toString('base64')}`;
const logo = (await readFile(path.join(here, 'src/logo.svg'), 'utf8')).replace('<svg ', '<svg width="96" height="96" style="color:#0B2B3F" ');
const html = `<!doctype html><html><head><style>
@font-face{font-family:F;font-weight:600;src:url(${await font('familjen-grotesk-latin-600-normal.woff2')})}
@font-face{font-family:S;font-weight:400;src:url(${await font('schibsted-grotesk-latin-400-normal.woff2')})}
body{margin:0;width:1200px;height:630px;background:#F4F9FA;font-family:S;color:#0B2B3F;display:grid;grid-template-columns:640px 1fr;overflow:hidden}
.l{padding:64px 0 0 72px;display:flex;flex-direction:column;gap:30px}
.b{display:flex;align-items:center;gap:4px;font:600 52px/1 F;letter-spacing:-.035em}
h1{margin:0;font:600 76px/1 F;letter-spacing:-.04em}
.c{background:linear-gradient(transparent 62%,#F5B730 62%,#F5B730 92%,transparent 92%);padding:0 3px}
p{margin:0;font-size:26px;line-height:1.4;color:#3F6478;max-width:520px}
.r{position:relative;margin:48px 48px 48px 0;border-radius:36px;overflow:hidden;background:#D8EAF6}
.r div{position:absolute;left:0;right:0}
</style></head><body>
<div class="l"><div class="b">${logo}pescada</div><h1>Every document <span class="c">caught.</span></h1><p>Tracked document exchange for accounting firms in Spain, Italy, France, Germany and Portugal.</p></div>
<div class="r"><div style="left:50%;top:60px;width:240px;height:240px;margin-left:-120px;border-radius:50%;background:#F5B730"></div><div style="top:240px;bottom:0;background:#1A5DB4"></div><div style="top:370px;bottom:0;background:#0F7A75"></div><div style="top:440px;bottom:0;background:#0B2B3F"></div></div>
</body></html>`;
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(html);
await p.waitForTimeout(300);
await p.screenshot({ path: path.join(here, 'src/og.png') });
await b.close();
console.log('wrote site/src/og.png');
