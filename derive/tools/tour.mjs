// Dev tool: visual tour of the real game (index.html, full shell) at iPhone 13 landscape with touch.
// Teleports the astronaut to every place of the sector, lets the live loop run, and saves one PNG
// per stop, plus the map, the pause menu and the Établi.
// Usage: node tools/tour.mjs [outDir] [only,comma,separated,stops] [cssW cssH]
//   e.g. node tools/tour.mjs /tmp/tour            (every stop, 750 × 342 CSS px at 3×)
//        node tools/tour.mjs /tmp/tour orion_in,helios 844 390
// Runs with ?god (nothing kills the camera), ?reveal (radar and map fully known) and every item.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStatic, launchBrowser } from './shot.mjs';

/** Stop name → how to get there (a teleportTo target, or absolute offsets from the sector centre). */
const STOPS = [
  { name: 'albatros', to: 'dock' },
  { name: 'albatros_out', xy: [0, 190] },
  { name: 'colibri', to: 'keycard' },
  { name: 'colibri_out', xy: [1250, -950] },
  { name: 'belt', xy: [-1500, 1350] },
  { name: 'orion_door', to: 'orion:door1' },
  { name: 'orion_in', to: 'explosives' },
  { name: 'orion_supply', to: 'orion:refill0' },
  { name: 'selene', to: 'rubble' },
  { name: 'tycho', to: 'heatshield' },
  { name: 'twins', xy: [400, 2900] },
  { name: 'helios', to: 'anchor' },
  { name: 'maelstrom', to: 'maelstrom' },
  { name: 'maelstrom_close', xy: [-300, -3420], freeze: true },
  { name: 'suns_close', xy: [240, 3350], freeze: true },
  { name: 'ulysse', to: 'capsule' },
  { name: 'charybde', to: 'charybde' },
  { name: 'mistral', xy: [-3300, -2520] },
  { name: 'satellite', to: 'sat1' },
  { name: 'storm', xy: [4880, 0] },
];

const [, , outArg = 'tour', onlyArg = '', wArg = '750', hArg = '342'] = process.argv;
const OUT = resolve(outArg);
mkdirSync(OUT, { recursive: true });
const only = onlyArg ? new Set(onlyArg.split(',')) : null;

const { server, url } = await startStatic();
const browser = await launchBrowser();
const ctx = await browser.newContext({
  viewport: { width: Number(wArg), height: Number(hArg) }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${url}/index.html?seed=12345&mute&god&reveal&items=all&bank=400&autostart`);
await page.waitForFunction(() => window.__derive && window.__derive.state() === 'PLAYING', null, { timeout: 15000 });
await page.waitForTimeout(3500); // the start banner fades

const shot = (name) => page.screenshot({ path: resolve(OUT, `${name}.png`) });
for (const s of STOPS) {
  if (only && !only.has(s.name)) continue;
  await page.evaluate((s) => {
    const d = window.__derive, C = 5120;
    d.freeze(false);
    if (s.to) d.teleportTo(s.to);
    else { const p = d.spotNear(C + s.xy[0], C + s.xy[1]); d.teleport(p.x, p.y); }
    d.setPlayer({ vx: 0, vy: 0, hull: 100, o2: 150 });
    if (s.freeze) { d.freeze(true); d.step(2); } // a spot the live pull would not let you hold
  }, s);
  await page.waitForTimeout(s.freeze ? 300 : 1600);
  await shot(s.name);
  console.log('saved', s.name);
}
if (!only || only.has('menus')) {
  await page.evaluate(() => { window.__derive.teleportTo('dock'); window.__derive.game.setState('MAP'); });
  await page.waitForTimeout(500); await shot('menu_map');
  await page.evaluate(() => window.__derive.game.setState('PAUSED'));
  await page.waitForTimeout(400); await shot('menu_pause');
  await page.evaluate(() => window.__derive.game.setState('SHOP'));
  await page.waitForTimeout(400); await shot('menu_shop');
  await page.evaluate(() => window.__derive.game.setState('PLAYING'));
  console.log('saved menus');
}
await browser.close();
server.close();
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log(`tour: no console errors or warnings — ${OUT}`);
