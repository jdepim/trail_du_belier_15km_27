// Dev tool: render the PWA / apple-touch icons from the in-code pixel art.
// Usage: node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, GAME_ROOT } from '../tests/e2e/server.mjs';
const require = createRequire(import.meta.url);
const pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const { server, url } = await startServer();
const browser = await pw.chromium.launch();
const page = await browser.newPage();
await page.goto(`${url}/tools/icon.html`);
await page.waitForFunction(() => document.title === 'ready');
for (const n of [180, 192, 512]) {
  const data = await page.evaluate((n) => window.renderIcon(n), n);
  writeFileSync(resolve(GAME_ROOT, 'icons', `icon-${n}.png`), Buffer.from(data.split(',')[1], 'base64'));
  console.log('icons/icon-' + n + '.png');
}
await browser.close(); server.close();
