// Dev tool: screenshot a page of the game. Usage: node tools/shot.mjs <path?query> <out.png> [w] [h] [waitMs]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { startServer } from '../tests/e2e/server.mjs';
const require = createRequire(import.meta.url);
const pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const [, , path = 'index.html', out = 'shot.png', w = '1400', h = '900', wait = '800'] = process.argv;
const { server, url } = await startServer();
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type() + ':', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`${url}/${path}`);
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out, fullPage: true });
await browser.close(); server.close();
console.log('saved', out);
