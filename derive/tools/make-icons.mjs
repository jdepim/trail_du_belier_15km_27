// Dev tool: render the PWA / apple-touch icons from the in-code pixel art (tools/icon.html) with the
// globally installed Playwright. Usage: node tools/make-icons.mjs
// Writes icons/icon-180.png, icon-192.png, icon-512.png and icon-maskable-512.png.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStatic, launchBrowser, GAME_ROOT } from './shot.mjs';

const { server, url } = await startStatic();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${url}/tools/icon.html`);
  await page.waitForFunction(() => document.title === 'ready');
  mkdirSync(resolve(GAME_ROOT, 'icons'), { recursive: true });
  const jobs = [[180, false, 'icon-180.png'], [192, false, 'icon-192.png'], [512, false, 'icon-512.png'], [512, true, 'icon-maskable-512.png']];
  for (const [n, maskable, name] of jobs) {
    const data = await page.evaluate(([n, m]) => window.renderIcon(n, m), [n, maskable]);
    writeFileSync(resolve(GAME_ROOT, 'icons', name), Buffer.from(data.split(',')[1], 'base64'));
    console.log('icons/' + name);
  }
} finally {
  await browser.close();
  server.close();
}
