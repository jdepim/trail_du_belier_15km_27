// End-to-end smoke test: iPhone 13 landscape emulation, real touch events, real game loop.
// Run: node tests/e2e/smoke.mjs   (Playwright is resolved from the global npm root)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log(`ok   - ${name}`); } catch (e) { failed++; console.log(`FAIL - ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const { server, url } = await startServer();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ ...pw.devices['iPhone 13 landscape'] });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
const G = (fn, arg) => page.evaluate(fn, arg);
const shot = (n) => page.screenshot({ path: resolve(SHOTS, n) });
const wait = (ms) => page.waitForTimeout(ms);
const cdp = await context.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 6, radiusY: 6, force: 1 })) });
const center = (sel) => G((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
const player = () => G(() => { const p = window.__dino.game.player; return { x: p.x, y: p.y, vx: p.vx, state: p.state, onGround: p.onGround, hp: p.hp, attackT: p.attackT }; });

try {
  await step('title screen: three dinosaurs to choose from, no errors', async () => {
    await page.goto(`${url}/index.html?mute&seed=5`);
    await page.waitForSelector('[data-pick=robuste]');
    assert.equal(await page.locator('.card').count(), 3);
    await wait(300);
    await shot('01-title.png');
  });

  await step('tap a card starts the game with HUD and touch controls', async () => {
    await page.tap('[data-pick=robuste]');
    await wait(400);
    assert.ok(await G(() => !!window.__dino.game));
    assert.ok(await page.isVisible('#controls'));
    assert.ok(await page.isVisible('[data-btn=attack]'));
    const info = await G(() => ({ w: document.getElementById('game').width, h: document.getElementById('game').height, s: window.__dino.renderer.scale }));
    assert.ok(info.h >= 150 && info.h <= 260, `internal height ${info.h}`);
    await shot('02-start.png');
  });

  await step('virtual joystick walks the dinosaur (real touch events)', async () => {
    const x0 = (await player()).x;
    await touch('touchStart', [{ x: 120, y: 300, id: 1 }]);
    await touch('touchMove', [{ x: 170, y: 300, id: 1 }]);
    await wait(900);
    const p = await player();
    await touch('touchEnd', []);
    assert.ok(p.x > x0 + 30, `moved ${p.x - x0}px`);
  });

  await step('Sauter and Mordre buttons respond to touch', async () => {
    await wait(300);
    const jb = await center('[data-btn=jump]');
    await touch('touchStart', [{ ...jb, id: 2 }]);
    await wait(120);
    const p = await player();
    await touch('touchEnd', []);
    assert.equal(p.onGround, false, 'in the air');
    await wait(900);
    const ab = await center('[data-btn=attack]');
    await touch('touchStart', [{ ...ab, id: 3 }]);
    await wait(40);
    const q = await player();
    await touch('touchEnd', []);
    assert.ok(q.attackT > 0, 'biting');
  });

  await step('joystick + button at the same time (multi-touch)', async () => {
    await wait(500);
    const x0 = (await player()).x;
    const jb = await center('[data-btn=jump]');
    await touch('touchStart', [{ x: 120, y: 300, id: 1 }]);
    await touch('touchMove', [{ x: 170, y: 300, id: 1 }]);
    await touch('touchStart', [{ x: 170, y: 300, id: 1 }, { ...jb, id: 2 }]);
    await wait(250);
    const p = await player();
    await touch('touchEnd', []);
    assert.ok(p.x > x0 + 10 && !p.onGround, 'running jump');
  });

  await step('hunt: bite a creature to death, harvest the carcass via Interagir', async () => {
    await G(() => {
      const g = window.__dino.game;
      g.creatures = []; g.spawnCreatures = false;
    });
    await G(async () => {
      const g = window.__dino.game, p = g.player;
      const { Creature } = await import('./src/creature.js');
      const { CREATURES } = await import('./src/data/creatures.js');
      const c = new Creature(CREATURES.dryo, p.cx + p.facing * 14, p.y + p.h);
      c.stats = { ...c.stats, speed: 0 };
      g.creatures.push(c);
      window.__prey = c;
    });
    const ab = await center('[data-btn=attack]');
    for (let i = 0; i < 6 && await G(() => window.__prey.alive); i++) {
      await G(() => { const p = window.__dino.game.player; window.__prey.x = p.facing > 0 ? p.x + p.w + 1 : p.x - window.__prey.w - 1; });
      await touch('touchStart', [{ ...ab, id: 3 }]); await wait(60); await touch('touchEnd', []); await wait(500);
    }
    assert.equal(await G(() => window.__prey.alive), false);
    await wait(700);
    assert.equal(await G(() => window.__dino.game.carcasses.length), 1);
    await G(() => { const g = window.__dino.game; const c = g.carcasses[0]; g.player.x = c.x; });
    await wait(200);
    assert.equal(await page.textContent('#ilabel'), 'Dépecer');
    await shot('03-carcass.png');
    const ib = await center('[data-btn=interact]');
    await touch('touchStart', [{ ...ib, id: 4 }]); await wait(60); await touch('touchEnd', []);
    await wait(200);
    const inv = await G(() => window.__dino.game.inventory.toJSON());
    assert.ok(inv.skin >= 1 && inv.bone >= 1 && inv.meat >= 1, JSON.stringify(inv));
  });

  await step('eat from the HUD raises hunger', async () => {
    await G(() => { window.__dino.game.player.hunger = 40; });
    await page.tap('[data-hud=eat]');
    await wait(100);
    assert.ok(await G(() => window.__dino.game.player.hunger > 55));
  });

  await step('build menu → place a tent with the Poser button', async () => {
    await G(() => window.__dino.game.inventory.addAll({ skin: 12, bone: 12 }));
    await page.tap('[data-hud=build]');
    await page.waitForSelector('#buildmenu:not(.hidden)');
    await shot('04-buildmenu.png');
    await page.tap('[data-bid=tente]');
    await wait(300);
    assert.ok(await page.isVisible('#buildbar'));
    await shot('05-ghost.png');
    await page.tap('[data-build=place]');
    await wait(300);
    assert.equal(await G(() => window.__dino.game.structures.length), 1);
    await G(() => { const g = window.__dino.game; g.builder.cancel(); g.player.facing = -g.player.facing; g.builder.start('feu'); });
    await wait(100);
    await page.tap('[data-build=place]');
    await wait(200);
    assert.equal(await G(() => window.__dino.game.structures.length), 2, await G(() => window.__dino.game.lastToast));
    await G(() => { const g = window.__dino.game; g.builder.cancel(); g.clock = 360 * 0.7; });
    await wait(400);
    await shot('06-camp-night.png');
  });

  await step('tame a compy and see it follow', async () => {
    await G(async () => {
      const g = window.__dino.game, p = g.player;
      g.clock = 360 * 0.3;
      g.inventory.add('meat', 3);
      const { Creature } = await import('./src/creature.js');
      const { CREATURES } = await import('./src/data/creatures.js');
      const c = new Creature(CREATURES.compy, p.cx + p.facing * 8, p.y + p.h);
      g.creatures.push(c);
      g.pack.tameInteraction(c).run();
    });
    await wait(200);
    assert.equal(await G(() => window.__dino.game.allies.length), 1);
    assert.match(await page.textContent('[data-hud=pack]'), /Meute 1\//);
    await page.tap('[data-hud=pack]');
    await wait(150);
    assert.match(await page.textContent('[data-hud=pack]'), /Récolte/);
  });

  await step('scenes: lake (swimming), cliff (climbing), forest, far predators', async () => {
    const find = await G(() => {
      const w = window.__dino.game.world;
      let lake = -1, cliff = -1, forest = -1;
      for (let x = w.spawn.tx; x < w.w - 20; x++) {
        if (lake < 0 && w.surface[x] > 70) lake = x;
        if (cliff < 0 && w.biome[x] === 'montagne' && w.surface[x] - w.surface[x + 1] >= 6) cliff = x + 1;
        if (forest < 0 && w.biome[x] === 'foret' && w.isClimbable(x, w.surface[x] - 1)) forest = x;
      }
      return { lake, cliff, forest };
    });
    const tp = (tx, row) => G(({ tx, row }) => {
      const g = window.__dino.game, p = g.player;
      p.x = tx * 8; p.y = (row ?? g.world.surface[tx]) * 8 - p.h - 1; p.vx = p.vy = 0;
      for (const a of g.allies) g.pack.teleportNear(a);
      g.camera.follow(p, g.viewW, g.viewH, g.world, 0, true);
    }, { tx, row });
    assert.ok(find.lake > 0 && find.cliff > 0 && find.forest > 0, JSON.stringify(find));
    await tp(find.lake, 69);
    await G(() => window.__dino.input.press('swim'));
    await wait(600);
    assert.equal((await player()).state, 'swim');
    await shot('07-swim.png');
    await G(() => window.__dino.input.release('swim'));
    await tp(find.cliff - 2);
    await G(() => { window.__dino.input.setAxis({ x: 1, y: 0 }); window.__dino.input.press('climb'); });
    await wait(900);
    assert.equal((await player()).state, 'climb');
    await shot('08-climb.png');
    await G(() => { window.__dino.input.clear(); });
    await tp(find.forest + 3);
    await wait(500);
    await shot('09-forest.png');
    // predators far from the start
    await G(async () => {
      const g = window.__dino.game, p = g.player;
      const { Creature } = await import('./src/creature.js');
      const { CREATURES } = await import('./src/data/creatures.js');
      for (const [id, dx] of [['raptor', 40], ['carno', 80], ['stego', -60]]) g.creatures.push(new Creature(CREATURES[id], p.cx + dx, g.world.surface[Math.floor((p.cx + dx) / 8)] * 8));
    });
    await wait(700);
    await shot('10-predators.png');
  });

  await step('performance: a simulation step + frame render stays well under 16 ms', async () => {
    const ms = await G(() => {
      const d = window.__dino, t0 = performance.now();
      for (let i = 0; i < 120; i++) { d.game.update(1 / 60); d.renderer.draw(d.game); }
      return (performance.now() - t0) / 120;
    });
    console.log(`       avg update+draw: ${ms.toFixed(2)} ms`);
    assert.ok(ms < 8, `${ms} ms`);
  });

  await step('save survives a reload and "Continuer" resumes it', async () => {
    await G(() => window.__dino.game.save());
    const allies = await G(() => window.__dino.game.allies.length);
    await page.reload();
    await page.waitForSelector('[data-act=continue]');
    await page.tap('[data-act=continue]');
    await wait(300);
    assert.equal(await G(() => window.__dino.game.structures.length), 2);
    assert.equal(await G(() => window.__dino.game.allies.length), allies);
  });

  await step('portrait orientation still renders and shows the rotate hint', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(400);
    assert.ok(await page.isVisible('#rotate'));
    await shot('11-portrait.png');
  });

  await step('no console errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} step(s) failed` : '\nall e2e steps passed');
process.exit(failed ? 1 : 0);
