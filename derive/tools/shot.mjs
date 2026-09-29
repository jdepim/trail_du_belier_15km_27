// Dev tool: screenshot any page of the game with the globally installed Playwright.
// Usage: node tools/shot.mjs <path?query> <out.png> [cssW] [cssH] [waitMs] [dpr] [clip x,y,w,h]
//   e.g. node tools/shot.mjs "tools/render-preview.html?at=orion" /tmp/orion.png 844 390 1500 3
// The page may set document.title = 'ready' to be captured as soon as it is drawn.
// Exports startStatic(root?) -> { server, url } and launchBrowser() for the other tools.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** Minimal static server over the game folder (random port). */
export function startStatic(root = GAME_ROOT) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(root, p));
      if (!file.startsWith(root)) throw new Error('outside');
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

/** Chromium from the global Playwright install (never installs anything). */
export async function launchBrowser() {
  const require = createRequire(import.meta.url);
  const pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
  return pw.chromium.launch();
}

async function main() {
  const [, , path = 'tools/render-preview.html', out = 'shot.png', w = '844', h = '390', wait = '1200', dpr = '1', clip = ''] = process.argv;
  const { server, url } = await startStatic();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(dpr) });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[preview]')) console.log('console.' + m.type() + ':', m.text()); });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${url}/${path}`);
  try { await page.waitForFunction(() => document.title === 'ready', null, { timeout: 20000 }); } catch { console.log('(no ready title, capturing anyway)'); }
  await page.waitForTimeout(Number(wait));
  const c = clip ? clip.split(',').map(Number) : null;
  await page.screenshot({ path: out, clip: c ? { x: c[0], y: c[1], width: c[2], height: c[3] } : undefined });
  await browser.close(); server.close();
  console.log('saved', out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
