// End-to-end smoke test: iPhone 13 landscape (touch), real browser, real game loop.
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

const TILE = 16, SURFACE_Y = 14;
const results = [];
let failed = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`ok   - ${name} (${Date.now() - t0} ms)`);
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed++;
    results.push(`FAIL - ${name}: ${e.message}`);
    console.log(`FAIL - ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

const { server, url } = await startServer();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ ...pw.devices['iPhone 13 landscape'] });
const page = await context.newPage();
const consoleErrors = [], pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

const G = (fn, arg) => page.evaluate(fn, arg);
const player = () => G(() => window.__gouffre.player());
const grapple = () => G(() => window.__gouffre.grapple());
const inject = (s) => G((s) => window.__gouffre.input.set(s), s);
const clearInput = () => G(() => window.__gouffre.input.clear());
const shot = (name) => page.screenshot({ path: resolve(SHOTS, name) });
async function waitFor(fn, timeout = 3000, every = 30) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for condition');
    await page.waitForTimeout(every);
  }
}
async function settle(ms = 400) { await page.waitForTimeout(ms); }

// CDP touch helpers (real touch events: touchstart / touchmove / touchend)
const cdp = await context.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })) });

try {
  await step('loads without errors, title screen shown', async () => {
    await page.goto(`${url}/index.html?seed=12345&mute`);
    await page.waitForSelector('button[data-act=play]', { timeout: 5000 });
    assert.equal(await G(() => window.__gouffre.state), 'TITLE');
    const info = await G(() => window.__gouffre.info());
    assert.equal(info.scale, 5, 'integer scale for 1026 px tall device canvas');
    assert.equal(info.H, Math.floor(1026 / 5));
    assert.equal(info.touch, true);
    await settle(300);
    await shot('01-title.png');
  });

  await step('tap "Jouer" starts the game and shows touch controls', async () => {
    await page.tap('button[data-act=play]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    const vis = await G(() => getComputedStyle(document.getElementById('controls')).display);
    assert.equal(vis, 'block');
    await settle(500);
    await shot('02-camp.png');
  });

  await step('player walks (injected input)', async () => {
    const p0 = await player();
    assert.equal(p0.onGround, true);
    await inject({ x: -1, y: 0 });        // toward the Forge (the shaft is to the right)
    await settle(500);
    const p1 = await player();
    assert.ok(p0.x - p1.x > 30, `moved ${p0.x - p1.x}px`);
    assert.equal(p1.anim, 'run');
    assert.equal(p1.facing, -1);
    await inject({ x: 1, y: 0 });
    await settle(250);
    assert.equal((await player()).facing, 1);
    await clearInput();
    await settle(200);
  });

  await step('player jumps and lands', async () => {
    const p0 = await player();
    await inject({ jump: true });
    const air = await waitFor(async () => { const p = await player(); return p.y < p0.y - 30 ? p : null; }, 1500, 16);
    assert.ok(air.anim === 'jump' || air.anim === 'fall');
    await inject({ jump: false });
    await waitFor(async () => (await player()).onGround, 2000);
    assert.ok(Math.abs((await player()).y - p0.y) < 1, 'back on the ground');
  });

  await step('grapple fires, attaches to the headframe beam and reels up', async () => {
    const gen = await G(() => window.__gouffre.gen());
    const bx = Math.round((gen.camp.beam.x0 + gen.camp.beam.x1) / 2);
    await G((bx) => window.__gouffre.teleport(bx, 13), bx);
    await settle(200);
    const p0 = await player();
    await inject({ x: 0, y: -1 });       // aim straight up
    await G(() => window.__gouffre.input.tap('grapple'));
    const gr = await waitFor(async () => { const g = await grapple(); return g.state === 'attached' ? g : null; }, 1500, 16);
    assert.equal(gr.anchorTy, gen.camp.beam.y, 'hooked the beam');
    await settle(900);                    // still holding up = reel in
    const p1 = await player();
    const g1 = await grapple();
    assert.ok(g1.length < gr.length - 20, `reeled ${gr.length.toFixed(1)} -> ${g1.length.toFixed(1)}`);
    assert.ok(p1.y < p0.y - 20, `lifted ${p0.y - p1.y}px`);
    await shot('03-grapple.png');
    await inject({ x: 0.9, y: 0 });       // swing
    await settle(300);
    await G(() => window.__gouffre.input.tap('jump')); // jump-release
    await waitFor(async () => (await grapple()).state !== 'attached', 1000);
    await clearInput();
    await waitFor(async () => (await player()).onGround, 3000);
  });

  await step('digs down through several tiles in the shaft', async () => {
    const gen = await G(() => window.__gouffre.gen());
    const sx = gen.camp.shaft.x0 + 1;
    await G(({ sx, y }) => window.__gouffre.teleport(sx, y), { sx, y: gen.camp.shaft.y1 });
    await waitFor(async () => (await player()).onGround, 2000);
    const d0 = (await player()).depth;
    await inject({ x: 0, y: 1, attack: true });
    await waitFor(async () => (await player()).depth >= d0 + 4, 12000, 100);
    await shot('04-dig.png');
    await clearInput();
    const p = await player();
    assert.ok(p.depth >= d0 + 4, `depth ${d0} -> ${p.depth}`);
    await settle(300);
    // climb back out of the 1-wide hole with the grapple (aim assist onto the shaft walls)
    await inject({ x: 0, y: -1 });
    await G(() => window.__gouffre.input.tap('grapple'));
    await waitFor(async () => (await grapple()).state === 'attached', 1500, 16);
    await settle(700);
    assert.ok((await player()).depth < p.depth, 'reeled up the hole');
    await clearInput();
    await G(() => window.__gouffre.input.tap('grapple')); // re-press = let go
    await waitFor(async () => (await grapple()).state !== 'attached', 1000);
  });

  await step('touch: floating stick moves the player (CDP touch events)', async () => {
    await G(() => window.__gouffre.teleport(24, 13));
    await settle(300);
    const lay = await G(() => window.__gouffre.input.layout());
    const sx = lay.stickGhost.x, sy = lay.stickGhost.y;
    const x0 = (await player()).x;
    await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
    for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ x: sx + i * 10, y: sy, id: 1 }]); await page.waitForTimeout(16); }
    await settle(450);
    const st = await G(() => window.__gouffre.input.state);
    assert.ok(st.moveX > 0.5, `moveX ${st.moveX}`);
    const stickShown = await G(() => getComputedStyle(document.querySelector('.stick-base')).display);
    assert.equal(stickShown, 'block');
    await shot('05-touch-stick.png');
    await touch('touchEnd', []);
    await settle(150);
    assert.ok((await player()).x - x0 > 25, 'walked right with the stick');
    assert.equal((await G(() => window.__gouffre.input.state)).moveX, 0, 'stick released');
  });

  await step('touch: jump button + stick at the same time (multi-touch)', async () => {
    const lay = await G(() => window.__gouffre.input.layout());
    const sx = lay.stickGhost.x, sy = lay.stickGhost.y;
    await waitFor(async () => (await player()).onGround, 2000);
    const p0 = await player();
    await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
    await touch('touchMove', [{ x: sx - 40, y: sy, id: 1 }]);
    await touch('touchStart', [{ x: sx - 40, y: sy, id: 1 }, { x: lay.jump.x, y: lay.jump.y, id: 2 }]);
    const air = await waitFor(async () => { const p = await player(); return p.y < p0.y - 24 ? p : null; }, 1500, 16);
    assert.ok(air.vx < 0, 'moving left while jumping');
    const down = await G(() => document.querySelector('.tbtn-jump').classList.contains('down'));
    assert.equal(down, true, 'button pressed state');
    await touch('touchEnd', [{ x: sx - 40, y: sy, id: 1 }]);
    await touch('touchEnd', []);
    await waitFor(async () => (await player()).onGround, 2000);
  });

  await step('touch: attack button digs, grapple button fires', async () => {
    const lay = await G(() => window.__gouffre.input.layout());
    const p = await player();
    const below = { tx: p.tileX, ty: p.tileY + 1 };
    const t0 = await G((b) => window.__gouffre.tile(b.tx, b.ty), below);
    await touch('touchStart', [{ x: lay.stickGhost.x, y: lay.stickGhost.y, id: 1 }]);
    await touch('touchMove', [{ x: lay.stickGhost.x, y: lay.stickGhost.y + 40, id: 1 }]); // aim down
    await touch('touchStart', [{ x: lay.stickGhost.x, y: lay.stickGhost.y + 40, id: 1 }, { x: lay.attack.x, y: lay.attack.y, id: 3 }]);
    await settle(120);
    await touch('touchEnd', [{ x: lay.stickGhost.x, y: lay.stickGhost.y + 40, id: 1 }]);
    await touch('touchEnd', []);
    const t1 = await G((b) => window.__gouffre.tile(b.tx, b.ty), below);
    assert.ok(t1.damage > t0.damage || t1.id !== t0.id, 'tile under the feet was hit');
    await touch('touchStart', [{ x: lay.grapple.x, y: lay.grapple.y, id: 4 }]);
    await page.waitForTimeout(60);
    await touch('touchEnd', []);
    await waitFor(async () => (await grapple()).state !== 'idle', 800, 16);
    await waitFor(async () => { const g = await grapple(); return g.state === 'idle' || g.state === 'attached'; }, 2000);
    if ((await grapple()).state === 'attached') { await G(() => window.__gouffre.input.tap('grapple')); }
  });

  await step('pause button opens the pause menu, "Reprendre" resumes', async () => {
    const lay = await G(() => window.__gouffre.input.layout());
    await touch('touchStart', [{ x: lay.pause.x, y: lay.pause.y, id: 5 }]);
    await touch('touchEnd', []);
    await waitFor(() => G(() => window.__gouffre.state === 'PAUSED'));
    await settle(200);
    await shot('06-pause.png');
    await page.tap('text=Reprendre');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
  });

  await step('contextual "Forge" button near the blacksmith opens the shop overlay', async () => {
    const gen = await G(() => window.__gouffre.gen());
    const tx = Math.floor(gen.camp.forge.npcX / TILE) + 1;
    await G((tx) => window.__gouffre.teleport(tx, 13), tx);
    const ctxBtn = await waitFor(async () => { const l = await G(() => window.__gouffre.input.layout()); return l.interact.hidden ? null : l.interact; }, 1500);
    const label = await G(() => document.querySelector('.tbtn-ctx').textContent);
    assert.equal(label, 'Forge');
    await touch('touchStart', [{ x: ctxBtn.x, y: ctxBtn.y, id: 6 }]);
    await touch('touchEnd', []);
    await waitFor(() => G(() => window.__gouffre.state === 'SHOP'));
    await settle(150);
    await shot('06b-forge.png');
    await page.tap('text=Retour');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    await G(() => window.__gouffre.teleport(26, 13));
    await waitFor(async () => (await G(() => window.__gouffre.input.layout())).interact.hidden, 1500);
  });

  await step('deeper layers render (catacombs, crystal caves, abyss, the Heart)', async () => {
    const stops = [[52, '07-catacombes.png'], [128, '08-cristaux.png'], [205, '09-abysse.png'], [265, '10-coeur.png']];
    for (const [d, name] of stops) {
      if (d === 265) {
        const gen = await G(() => window.__gouffre.gen());
        await G((a) => window.__gouffre.teleport(a.x0 + 8, a.y1), gen.arena);
      } else {
        await G((d) => window.__gouffre.teleportDepth(d), d);
      }
      await settle(900);
      const p = await player();
      assert.ok(p.depth >= d - 8, `at depth ${p.depth}`);
      await shot(name);
    }
  });

  await step('portrait shows "Tourne ton iPhone" and pauses; landscape restores', async () => {
    await page.setViewportSize({ width: 342, height: 750 });
    await settle(600);
    const shown = await G(() => getComputedStyle(document.getElementById('rotate')).display);
    assert.equal(shown, 'flex');
    assert.equal(await G(() => window.__gouffre.state), 'PAUSED');
    await shot('11-portrait.png');
    await page.setViewportSize({ width: 750, height: 342 });
    await settle(600);
    assert.equal(await G(() => getComputedStyle(document.getElementById('rotate')).display), 'none');
    await page.tap('text=Reprendre');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    assert.equal((await G(() => window.__gouffre.info())).scale, 5);
  });

  await step('death: summary with the lost loot, then a new expedition (new seed, empty backpack, no relics)', async () => {
    const seed0 = (await G(() => window.__gouffre.gen())).seed;
    const deaths0 = (await G(() => window.__gouffre.save())).stats.deaths;
    await G(() => { const g = window.__gouffre; g.giveOre('iron', 4); g.game.run.gold = 9; g.giveRelic('magnet'); });
    // (the Heart visit above may have left i-frames from the Guardian: clear them)
    await G(() => { const p = window.__gouffre.game.player; p.iframes = 0; p.takeDamage(9999, null, { cause: 'guardian' }); });
    assert.equal((await player()).dead, true);
    await waitFor(() => G(() => window.__gouffre.state === 'DEAD'), 4000);
    await settle(150);
    const txt = await G(() => document.querySelector('[data-ui=death]').innerText);
    assert.match(txt, /Mort à −\d+ m/);
    assert.match(txt, /Gardien/, 'cause of death');
    assert.match(txt, /Fer ×4/, 'lost ore listed');
    assert.match(txt, /Aimant/, 'lost relic listed');
    assert.equal((await G(() => window.__gouffre.save())).stats.deaths, deaths0 + 1, 'death saved');
    await shot('12-death.png');
    await page.tap('[data-act=restart]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    const p = await player();
    assert.equal(p.dead, false);
    assert.equal(p.hp, p.maxHp);
    assert.ok(p.feetY <= SURFACE_Y * TILE, 'back at the camp');
    assert.notEqual((await G(() => window.__gouffre.gen())).seed, seed0, 'new mine');
    const r = await G(() => window.__gouffre.run());
    assert.deepEqual([r.bagCount, r.gold, r.relics.length], [0, 0, 0], 'empty backpack, no run gold, no relics');
    assert.equal((await G(() => window.__gouffre.stats())).magnetMul, 1, 'relic effects gone');
  });

  // ------------------------------------------------------------ regressions (review fixes)

  await step('touch: sliding between Saut and Frapper never leaves a button stuck', async () => {
    await G(() => window.__gouffre.teleport(24, 13));
    await waitFor(async () => (await player()).onGround, 2000);
    const lay = await G(() => window.__gouffre.input.layout());
    const J = lay.jump, A = lay.attack;
    await touch('touchStart', [{ x: J.x, y: J.y, id: 11 }]);
    for (const b of [A, J, A]) {
      for (let k = 1; k <= 4; k++) await touch('touchMove', [{ x: J.x + (b.x - J.x) * k / 4, y: J.y + (b.y - J.y) * k / 4, id: 11 }]);
      await page.waitForTimeout(40);
    }
    await touch('touchEnd', []);
    await settle(150);
    const st = await G(() => ({ raw: { ...window.__gouffre.game.input.raw }, down: document.querySelectorAll('.tbtn.down').length, touches: window.__gouffre.game.input.touches.size }));
    for (const [a, v] of Object.entries(st.raw)) assert.equal(v, false, `${a} released`);
    assert.equal(st.down, 0, 'no .tbtn left in the down state');
    assert.equal(st.touches, 0);
    // no phantom auto-attack, and the next tap on Saut jumps
    await G(() => { const p = window.__gouffre.game.player; window.__strikes = 0; p.__strike = p.strike; p.strike = function () { window.__strikes++; return p.__strike.call(p); }; });
    await settle(600);
    const phantom = await G(() => { const p = window.__gouffre.game.player; p.strike = p.__strike; delete p.__strike; return window.__strikes; });
    assert.equal(phantom, 0, 'no strike without a finger on screen');
    await waitFor(async () => (await player()).onGround, 2000);
    const y0 = (await player()).y;
    await touch('touchStart', [{ x: J.x, y: J.y, id: 12 }]);
    await waitFor(async () => (await player()).y < y0 - 20, 1500, 16);
    await touch('touchEnd', []);
    await waitFor(async () => (await player()).onGround, 2000);
  });

  await step('keyboard: an arrow still held through pause/resume keeps walking (auto-repeat)', async () => {
    await page.keyboard.down('ArrowRight');
    await settle(150);
    await G(() => { window.__gouffre.pause(); window.__gouffre.resume(); });
    await page.keyboard.down('ArrowRight'); // Playwright sends this one with repeat=true, like the OS auto-repeat
    const x0 = (await player()).x;
    await settle(400);
    const moved = (await player()).x - x0;
    await page.keyboard.up('ArrowRight');
    assert.ok(moved > 20, `walked ${moved.toFixed(1)} px after resume`);
    await settle(200);
  });

  await step('grapple catch while falling: no teleport, no upward fling', async () => {
    const log = await G(() => {
      const g = window.__gouffre, game = g.game, p = game.player;
      g.freeze(true);
      for (let ty = 14; ty < 60; ty++) for (let tx = 35; tx <= 37; tx++) g.setTile(tx, ty, 'air');
      g.teleport(36, 20);
      p.y = 160 + 90 - 7; p.prevY = p.y; p.vy = 380; p.vx = 0;
      game.camera.snap();
      g.input.set({ x: 0, y: -1 });
      g.input.tap('grapple');
      g.step(1);
      g.input.clear();
      const out = [];
      for (let i = 0; i < 30; i++) { const y0 = p.y, was = p.grapple.state; g.step(1); out.push({ was, dy: p.y - y0, vy: p.vy, len: p.grapple.length }); }
      return out;
    });
    const att = log.filter((r) => r.was === 'attached');
    assert.ok(att.length > 5, 'hook attached to the beam');
    const worst = Math.min(...att.map((r) => r.dy));
    assert.ok(worst > -1, `largest upward jump per tick ${worst.toFixed(1)} px`);
    assert.ok(att[0].vy > -20, `vy right after the catch ${att[0].vy.toFixed(1)}`);
    await G(() => { window.__gouffre.game.player.grapple.reset(); window.__gouffre.freeze(false); });
  });

  await step('hit-stop freezes exactly the requested number of ticks', async () => {
    const r = await G(() => {
      const g = window.__gouffre, game = g.game;
      g.freeze(true);
      const frozen = (s) => { game.hitStop(s); let n = 0; for (;;) { const t = game.time; g.step(1); if (game.time !== t) return n; n++; if (n > 20) return n; } };
      const out = { enemy: frozen(0.05), tile: frozen(0.018), hurt: frozen(0.07) };
      g.freeze(false);
      return out;
    });
    assert.deepEqual(r, { enemy: 3, tile: 1, hurt: 4 });
  });

  await step('dynamic lights stay on in frames without a tick, during hit-stop and pause', async () => {
    const r = await G(() => {
      const g = window.__gouffre, game = g.game, L = game.lighting, R = game.renderer, p = game.player;
      g.freeze(true);
      const orig = game.enemies.addLights;
      const lx = p.x + 64, ly = p.y;
      game.enemies.addLights = (lighting) => lighting.addLight(lx, ly, 1, [255, 40, 40]);
      const val = () => { const i = Math.floor(lx / 16) - L.tx0, j = Math.floor(ly / 16) - L.ty0; return +L.L[j * L.w + i].toFixed(3); };
      const out = [];
      g.step(1); out.push(val());           // frame with a tick
      R.render(0.5); out.push(val());       // frame without a tick (120 Hz)
      game.hitStop(0.05); g.step(1); out.push(val()); // hit-stop tick
      g.pause(); R.render(1); out.push(val());         // paused frame
      g.resume();
      game.enemies.addLights = orig;
      g.step(1);
      g.freeze(false);
      return out;
    });
    assert.deepEqual(r, [1, 1, 1, 1]);
  });

  await step('standing on the rim of a 1-wide hole does not drag the player in', async () => {
    const r = await G(() => {
      const g = window.__gouffre, game = g.game, p = game.player;
      g.freeze(true);
      for (let ty = 14; ty < 20; ty++) g.setTile(45, ty, 'air');
      p.teleport(736 - 3 + p.w / 2, 14 * 16); game.camera.snap(); g.input.clear();
      g.step(2);
      const before = { x: p.x, feetY: p.feetY };
      g.step(40);
      const after = { x: p.x, feetY: p.feetY };
      g.freeze(false);
      return { before, after };
    });
    assert.equal(r.after.feetY, r.before.feetY, 'still on the rim');
    assert.ok(Math.abs(r.after.x - r.before.x) < 0.01, 'not pulled toward the hole');
  });

  await step('mining the tile holding a root / stalactite removes the decoration', async () => {
    const r = await G(() => {
      const g = window.__gouffre, game = g.game, w = game.world;
      const hanging = ['roots', 'stalactite'];
      for (let ty = 16; ty < 200; ty++) for (let tx = 3; tx < w.w - 3; tx++) {
        if (!hanging.includes(g.tile(tx, ty).key) || !g.tile(tx, ty - 1).solid || g.tile(tx, ty - 1).key === 'bedrock') continue;
        const id = w.get(tx, ty - 1);
        let res; let n = 0;
        do { res = w.damageTile(tx, ty - 1, 99, 9); n++; } while (!res.broken && n < 10);
        game.tileBroken(tx, ty - 1, id, 'player'); // what Player.strike() does
        return { deco: g.tile(tx, ty).key, support: g.tile(tx, ty - 1).key };
      }
      return null;
    });
    assert.ok(r, 'found a hanging decoration');
    assert.equal(r.support, 'air');
    assert.equal(r.deco, 'air', 'decoration crumbled with its support');
  });

  await step('running: the hero stays on one screen column (no 1-px shimmer)', async () => {
    await G(() => {
      const g = window.__gouffre, game = g.game, R = game.renderer;
      g.newRun(12345);
      g.setGod(true);
      for (let tx = 3; tx <= 68; tx++) { g.setTile(tx, 40, 'air'); g.setTile(tx, 41, 'air'); g.setTile(tx, 42, 'stone'); g.setTile(tx, 39, 'stone'); }
      g.teleport(4, 41);
      window.__rec = null;
      if (!R.__origDrawPlayer) R.__origDrawPlayer = R.drawPlayer;
      R.drawPlayer = function (ctx, cx, cy) { if (window.__rec) window.__rec.push(Math.round(this._pp.x) + game.player.w / 2 - cx); return R.__origDrawPlayer.call(this, ctx, cx, cy); };
      g.input.set({ x: 1, y: 0 });
    });
    await settle(1500);
    await G(() => { window.__rec = []; });
    await settle(1500);
    const s = await G(() => { const r = window.__rec; window.__rec = null; window.__gouffre.input.clear(); window.__gouffre.setGod(false); return r; });
    let blips = 0;
    for (let i = 1; i < s.length - 1; i++) if (s[i] !== s[i - 1] && s[i + 1] === s[i - 1]) blips++;
    assert.ok(s.length > 30, `${s.length} frames recorded`);
    assert.ok(blips <= 2, `${blips} one-frame back-and-forth blips over ${s.length} frames`);
  });

  await step('boss vestibule of seed 2654435761 has no hanging lava (screenshot)', async () => {
    const r = await G(() => {
      const g = window.__gouffre, game = g.game;
      g.newRun(2654435761);
      const w = game.world;
      let exposed = 0;
      for (let ty = 250; ty < 288; ty++) for (let tx = 2; tx < 70; tx++) {
        if (g.tile(tx, ty).key !== 'lava') continue;
        for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty + 1]]) { const t = g.tile(nx, ny); if (!t.solid && t.key !== 'lava') exposed++; }
      }
      // frozen view of the vestibule (the player would otherwise drop into the arena)
      g.freeze(true);
      g.teleport(36, 269);
      game.hud.update(3);
      g.step(0);
      return { exposed, gen: g.gen().seed, w: w.w };
    });
    assert.equal(r.exposed, 0);
    await shot('13-vestibule.png');
    await G(() => window.__gouffre.freeze(false));
  });

  // ------------------------------------------------------------ enemies, combat, boss (step 2a)

  /** Carve a lit 6-tile-high gallery whose floor is row ty + 1 (in page context). */
  const carveGallery = (ty) => G((ty) => {
    const g = window.__gouffre;
    for (let tx = 3; tx <= 68; tx++) { for (let y = ty - 5; y <= ty; y++) g.setTile(tx, y, 'air'); g.setTile(tx, ty + 1, 'stone'); g.setTile(tx, ty - 6, 'stone'); }
    for (let tx = 8; tx <= 66; tx += 7) g.setTile(tx, ty - 3, 'torch');
  }, ty);

  await step('combat: strike a spawned enemy to death, its coins go to the run gold', async () => {
    await G(() => { const g = window.__gouffre; g.newRun(12345); g.setGod(false); g.clearEnemies(); });
    await carveGallery(40);
    await G(() => { const g = window.__gouffre; g.teleport(20, 40); g.game.player.facing = 1; });
    await settle(300);
    const e = await G(() => window.__gouffre.spawnEnemy('slime', 34, 0, { cd: 99 }));
    assert.equal(e.key, 'slime');
    assert.ok(e.hp > 10 && e.hp === e.maxHp, `depth-scaled hp ${e.hp}`);
    const gold0 = (await G(() => window.__gouffre.run())).gold;
    await inject({ x: 1, y: 0, attack: true });
    await waitFor(async () => { const l = await G(() => window.__gouffre.enemies()); return l.length === 1 && l[0].hp < l[0].maxHp; }, 3000, 16);
    await shot('15-combat-hit.png');
    await waitFor(async () => (await G(() => window.__gouffre.enemies())).length === 0, 6000, 30);
    await clearInput();
    const r0 = await G(() => window.__gouffre.run());
    assert.equal(r0.kills, 1, 'kill counted');
    await settle(150);
    await shot('15b-combat-coins.png');
    // walk over whatever coins bounced out of the magnet's reach
    const t0 = Date.now();
    for (;;) {
      const s2 = await G(() => ({ pk: window.__gouffre.pickups().filter((q) => q.kind === 'coin'), gold: window.__gouffre.run().gold, p: window.__gouffre.player() }));
      if (!s2.pk.length && s2.gold > gold0) break;
      if (Date.now() - t0 > 6000) throw new Error(`coins not collected: ${JSON.stringify(s2)}`);
      if (s2.pk.length) await inject({ x: s2.pk[0].x > s2.p.cx ? 1 : -1, y: 0 });
      await page.waitForTimeout(60);
    }
    await clearInput();
    const r1 = await G(() => window.__gouffre.run());
    assert.ok(r1.gold > gold0, `run gold ${gold0} -> ${r1.gold}`);
  });

  await step('combat: an enemy hurts the player (HP down, knockback, i-frames)', async () => {
    await G(() => { window.__gouffre.game.player.hp = window.__gouffre.game.player.stats.maxHp; });
    const hp0 = (await player()).hp;
    await G(() => window.__gouffre.spawnEnemy('skeleton', 4, 0, { cd: 99 }));
    const hit = await waitFor(async () => { const p = await player(); return p.hp < hp0 ? p : null; }, 2000, 16);
    assert.ok(hit.iframes > 0.6, 'i-frames after the hit');
    await shot('15c-hurt.png');
    await settle(250);
    assert.equal((await player()).hp, hit.hp, 'no damage during i-frames');
    await G(() => window.__gouffre.clearEnemies());
  });

  await step('every layer has its own enemies (screenshots)', async () => {
    const stops = [
      [26, ['slime', 'bat', 'slime'], '16-enemies-terre.png'],
      [62, ['skeleton', 'bat', 'slime', 'skeleton'], '17-enemies-catacombes.png'],
      [132, ['spider', 'ghost', 'bat', 'spider'], '18-enemies-cristaux.png'],
      [214, ['imp', 'golem', 'ghost', 'imp'], '19-enemies-abysse.png'],
    ];
    await G(() => window.__gouffre.setGod(true));
    for (const [d, keys, name] of stops) {
      const ty = SURFACE_Y + d;
      await G(() => window.__gouffre.clearEnemies());
      await carveGallery(ty);
      const made = await G(({ ty, keys }) => {
        const g = window.__gouffre;
        g.freeze(true);
        g.teleport(14, ty);
        const out = keys.map((k, i) => g.spawnEnemy(k, 34 + i * 46, 0, { cd: 99 }));
        // one hanger on the ceiling (bat asleep / spider on its thread) when the layer has one
        const hanger = keys.find((k) => k === 'bat' || k === 'spider');
        if (hanger) out.push(g.spawnEnemy(hanger, -40, 0, { anchor: 'ceiling', y: (ty - 5) * 16 }));
        g.step(24);
        return out;
      }, { ty, keys });
      assert.ok(made.every(Boolean), 'all spawned');
      const live = await G(() => window.__gouffre.enemies());
      assert.ok(live.length >= keys.length, `${live.length} enemies alive at -${d} m`);
      for (const e of live) assert.equal(await G((e) => window.__gouffre.game.world.rectSolid(e.x, e.y, e.w, e.h) && e.key !== 'ghost', e), false, `${e.key} not in rock`);
      await shot(name);
      await G(() => window.__gouffre.freeze(false));
    }
    await G(() => window.__gouffre.clearEnemies());
  });

  await step('boss: the Guardian wakes in the Heart, gates seal, HP bar; 3 phases; death hook', async () => {
    const gen = await G(() => window.__gouffre.gen());
    const a = gen.arena;
    await G((a) => { const g = window.__gouffre; g.setGod(true); g.clearEnemies(); g.teleport(a.x0 + 20, a.y1); }, a);
    const b0 = await waitFor(async () => { const b = await G(() => window.__gouffre.boss()); return b.enemy && b.enemy.state === 'intro' ? b : null; }, 2500, 30);
    assert.equal(b0.gatesSealed, true, 'arena sealed');
    assert.equal((await G((e) => window.__gouffre.tile(e.x0, e.y), a.entrance)).key, 'gate');
    assert.ok(b0.bar && b0.bar.name === "Le Gardien de l'Abysse", 'boss bar with its name');
    await settle(1400);
    // the bar is really drawn: sample the internal canvas at its left end
    const px = await G(() => {
      const game = window.__gouffre.game, R = game.renderer;
      const bw = Math.min(170, Math.round(R.W * 0.38));
      const x = Math.round(R.W / 2 - bw / 2) + 3, y = Math.max(5, game.safe.t + 4) + 12;
      return Array.from(R.ctx.getImageData(x, y, 1, 1).data);
    });
    assert.ok(px[0] > 100 && px[0] > px[1] + 40, `boss bar pixel ${px}`);
    await shot('20-boss-intro.png');
    await waitFor(async () => (await G(() => window.__gouffre.boss().enemy.state)) !== 'intro', 3000);
    await settle(900);
    await shot('21-boss-fight.png');
    await G(() => window.__gouffre.hurtBoss(window.__gouffre.game.enemies.boss.maxHp * 0.36));
    assert.equal((await G(() => window.__gouffre.boss())).enemy.phase, 1);
    await settle(2600);
    await shot('22-boss-phase2.png');
    await waitFor(async () => (await G(() => window.__gouffre.boss().enemy.state)) !== 'phase', 3000);
    await G(() => window.__gouffre.hurtBoss(window.__gouffre.game.enemies.boss.maxHp * 0.34));
    assert.equal((await G(() => window.__gouffre.boss())).enemy.phase, 2);
    await settle(2600);
    await shot('23-boss-rage.png');
    await waitFor(async () => (await G(() => window.__gouffre.boss().enemy.state)) !== 'phase', 3000);
    await G(() => window.__gouffre.hurtBoss(window.__gouffre.game.enemies.boss.hp + 10));
    assert.equal((await G(() => window.__gouffre.boss())).enemy.state, 'dying');
    await settle(1200);
    await shot('24-boss-dying.png');
    await waitFor(async () => (await G(() => window.__gouffre.run())).bossDefeated, 5000, 50);
    const end = await G(() => window.__gouffre.boss());
    assert.equal(end.defeated, true);
    assert.equal(end.gatesSealed, false, 'gates reopen');
    assert.equal(end.bar, null, 'bar gone');
    assert.equal((await G((e) => window.__gouffre.tile(e.x0, e.y), a.entrance)).key, 'air');
    await settle(700);
    await shot('25-boss-defeated.png');
    await G(() => window.__gouffre.setGod(false));
  });

  // ------------------------------------------------------------ economy & meta loop (step 2b)

  await step('victory: the Guardian\'s death opens the victory screen; "Continuer (NG+ 1)" starts a harder mine', async () => {
    await waitFor(() => G(() => window.__gouffre.state === 'VICTORY'), 6000, 50);
    await settle(200);
    const txt = await G(() => document.querySelector('[data-ui=victory]').innerText);
    assert.match(txt, /Gardien/);
    assert.match(txt, /NG\+ 1/);
    const sv = await G(() => window.__gouffre.save());
    assert.equal(sv.stats.victories, 1, 'victory saved');
    assert.ok(sv.gold > 0, 'the Guardian\'s treasure is banked');
    await shot('30-victory.png');
    const seed0 = (await G(() => window.__gouffre.gen())).seed;
    await page.tap('[data-act=ngplus]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    const r = await G(() => window.__gouffre.run());
    assert.equal(r.ngPlus, 1);
    assert.notEqual(r.seed, seed0);
    assert.equal((await G(() => window.__gouffre.save())).ngPlus, 1);
    const e = await G(() => window.__gouffre.spawnEnemy('slime', 60, 0, { cd: 99 }));
    assert.ok(e.maxHp >= Math.round(16 * 1.5), `NG+ slime hp ${e.maxHp}`);
    await G(() => { window.__gouffre.clearEnemies(); window.__gouffre.setGod(false); });
  });

  await step('boss (touch): floor framed above the thumb buttons; a rope-hanger is clawed off; its death clears minions, and dying in its last breath is no victory', async () => {
    const a = (await G(() => window.__gouffre.gen())).arena;
    const vict0 = (await G(() => window.__gouffre.save())).stats.victories;
    // backed against the right wall of the arena
    await G((a) => { const g = window.__gouffre; g.setGod(true); g.clearEnemies(); g.teleport(a.x1, a.y1); }, a);
    await waitFor(() => G(() => window.__gouffre.boss().gatesSealed), 2500, 30);
    await settle(1500);
    const geo = await G(() => {
      const game = window.__gouffre.game, R = game.renderer, cam = game.camera, p = game.player, lay = game.input.getLayout();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const css = (v, off) => (v * R.scale + off) / dpr;
      return {
        floor: css(game.enemies.arenaFloorY - cam.y, R.offY),
        band: Math.min(lay.jump.y - lay.jump.r, lay.attack.y - lay.attack.r),
        heroR: css(p.x + p.w - cam.x, R.offX),
        atkL: lay.attack.x - lay.attack.r,
      };
    });
    assert.ok(geo.floor < geo.band, `arena floor (${geo.floor.toFixed(0)} CSS px) above the Saut / Frapper buttons (${geo.band})`);
    assert.ok(geo.heroR < geo.atkL, `hero at the right wall (${geo.heroR.toFixed(0)}) left of Frapper (${geo.atkL})`);
    await shot('34-boss-right-wall.png');
    try {
    // hang on the arena's hanging pillar beside the Guardian's head: it is clawed / swiped off the rope
    const rope = await G((a) => {
      const g = window.__gouffre, game = g.game, p = game.player, b = game.enemies.boss;
      g.freeze(true);
      game.save.upgrades.grapple = 2; game.refreshStats();
      g.teleport(a.x0 + 14, a.y1); g.step(2);
      g.input.set({ x: 0, y: -1 }); g.input.tap('grapple');
      let n = 0; while (p.grapple.state !== 'attached' && n < 120) { g.step(1); n++; }
      const attached = p.grapple.state === 'attached';
      for (let k = 0; k < 400; k++) { const d = b.y + 4 - p.feetY; if (Math.abs(d) < 2) break; g.input.set({ x: 0, y: d > 0 ? 1 : -1 }); g.step(1); }
      g.input.set({ x: 0, y: 0 });
      g.setGod(false); p.hp = 400;
      const winds = [];
      for (let t = 0; t < 60 * 14; t++) {
        g.step(1);
        if (b.state.endsWith('_wind') && winds[winds.length - 1] !== b.state) winds.push(b.state);
        if (b.state === 'claw' || b.state === 'swipe') break;
      }
      return { attached, winds, state: b.state };
    }, a);
    assert.ok(rope.attached, 'hooked the hanging pillar');
    assert.ok(rope.state === 'claw' || rope.state === 'swipe', `claw or swipe against a player hanging beside its head (${rope.winds})`);
    await shot('35-boss-claw.png');
    const knocked = await G(() => {
      const g = window.__gouffre, game = g.game, p = game.player;
      for (let t = 0; t < 30 && p.grapple.state === 'attached'; t++) g.step(1);
      const off = p.grapple.state !== 'attached';
      g.input.clear(); p.hp = p.stats.maxHp; g.setGod(true);
      game.save.upgrades.grapple = 0; game.refreshStats();
      return { off, hp: p.hp };
    });
    assert.ok(knocked.off, 'knocked off the rope');
    // its death: minions and projectiles vanish at once; dying in its last breath forfeits the victory
    const end = await G(() => {
      const g = window.__gouffre, game = g.game, en = game.enemies, b = en.boss;
      b.phase = 2; en._summon(b); en._fireRain(b);
      const summoned = en.list.filter((m) => m.minion && m.alive && m.dying <= 0).length;
      g.killBoss(); g.step(2);
      const left = en.list.filter((m) => m.minion && m.alive && m.dying <= 0).length;
      const proj = en.projectiles.filter((q) => q.active).length;
      g.step(60 * 2);                       // 2 s into the 3 s death sequence
      g.setGod(false); g.die('bone');
      g.step(80);                           // the finale runs while the hero lies dead
      const snap = { banner: game.hud.bannerT > 0 ? game.hud.bannerTitle : null, bossDefeated: game.run.bossDefeated, finale: en.bossDefeated };
      g.step(60);
      g.freeze(false);
      return { summoned, left, proj, ...snap, state: g.state, victories: game.save.stats.victories };
    });
    assert.ok(end.summoned >= 2, 'minions were summoned');
    assert.equal(end.left, 0, 'minions vanish when the Guardian falls');
    assert.equal(end.proj, 0, 'every hostile projectile is gone');
    assert.equal(end.finale, true, 'the death sequence finished');
    assert.notEqual(end.banner, 'VICTOIRE !', 'no victory banner over a dead hero');
    assert.equal(end.bossDefeated, false);
    assert.equal(end.state, 'DEAD');
    assert.equal(end.victories, vict0, 'no victory counted');
    } finally {
      await G(() => { const g = window.__gouffre; g.freeze(false); g.input.clear(); g.game.save.upgrades.grapple = 0; g.game.refreshStats(); });
    }
    if ((await G(() => window.__gouffre.state)) !== 'DEAD') await G(() => { window.__gouffre.game.onPlayerDeath('abandon'); window.__gouffre.game.setState('DEAD'); });
    await page.tap('[data-act=restart]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    await G(() => window.__gouffre.setGod(false));
  });

  await step('ore: mined chunks fill the backpack, banking at the camp turns them into saved gold (survives a reload)', async () => {
    await G(() => { const g = window.__gouffre; g.newRun(424242); g.setGod(true); g.clearEnemies(); });
    await carveGallery(22);
    await G(() => {
      const g = window.__gouffre;
      g.teleport(20, 22); g.game.player.facing = 1;
      g.setTile(21, 22, 'copper'); g.setTile(21, 21, 'copper');
    });
    await settle(250);
    await inject({ x: 1, y: 0, attack: true });
    await waitFor(async () => (await G(() => window.__gouffre.run())).bagCount >= 2, 8000, 50);
    await clearInput();
    const r0 = await G(() => window.__gouffre.run());
    assert.deepEqual(r0.bag, { copper: 2 });
    assert.equal(r0.bagValue, 4);
    await settle(200);
    await shot('26-ore-backpack.png');
    const gold0 = (await G(() => window.__gouffre.save())).gold;
    await G(() => { window.__gouffre.game.run.gold = 6; window.__gouffre.teleport(31, 13); });
    await waitFor(async () => (await G(() => window.__gouffre.run())).bagCount === 0, 2000, 30);
    const sv = await G(() => window.__gouffre.save());
    assert.equal(sv.gold, gold0 + 4 + 6, 'bag value + run gold banked');
    assert.equal(await G(() => window.__gouffre.game.hud.tallyActive), true, 'tally shown');
    await settle(900);
    await shot('27-bank-tally.png');
    const stored = await G(() => JSON.parse(localStorage.getItem('gouffre.save.v1')));
    assert.equal(stored.gold, sv.gold, 'saved immediately');
    assert.ok(stored.stats.trips >= 1);
    await page.reload();
    await page.waitForSelector('button[data-act=play]', { timeout: 5000 });
    assert.equal((await G(() => window.__gouffre.save())).gold, sv.gold, 'banked gold persists across a reload');
    const label = await G(() => document.querySelector('button[data-act=play]').innerText);
    assert.match(label, /Continuer/i);
    assert.match(label, /Or banqué/);
    await settle(200);
    await shot('28-title-continue.png');
    await page.tap('button[data-act=play]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
  });

  await step('Forge: buying an upgrade with touch spends banked gold and applies it at once', async () => {
    await G(() => { const g = window.__gouffre; g.setGod(true); g.clearEnemies(); g.setBank(500); });
    const gen = await G(() => window.__gouffre.gen());
    const tx = Math.floor(gen.camp.forge.npcX / TILE) + 1;
    await G((tx) => window.__gouffre.teleport(tx, 13), tx);
    const ctxBtn = await waitFor(async () => { const l = await G(() => window.__gouffre.input.layout()); return l.interact.hidden ? null : l.interact; }, 1500);
    await touch('touchStart', [{ x: ctxBtn.x, y: ctxBtn.y, id: 21 }]);
    await touch('touchEnd', []);
    await waitFor(() => G(() => window.__gouffre.state === 'SHOP'));
    const cap0 = (await G(() => window.__gouffre.stats())).bagCapacity;
    const cost = await G(() => window.__gouffre.game.save.upgrades.bag === 0 ? 15 : null);
    assert.equal(cost, 15);
    await page.tap('[data-buy=bag]');
    await waitFor(async () => (await G(() => window.__gouffre.save())).upgrades.bag === 1, 1500);
    const sv = await G(() => window.__gouffre.save());
    assert.equal(sv.gold, 500 - cost);
    assert.ok((await G(() => window.__gouffre.stats())).bagCapacity > cap0, 'bag capacity applied');
    assert.equal((await G(() => JSON.parse(localStorage.getItem('gouffre.save.v1')))).upgrades.bag, 1, 'saved');
    // unaffordable upgrades are disabled, the card shows the new level
    await G(() => window.__gouffre.setBank(10));
    assert.equal(await G(() => document.querySelector('[data-buy=pick]').disabled), true);
    assert.equal(await G(() => document.querySelectorAll('[data-up=bag] .pip.on').length), 1);
    await G(() => window.__gouffre.setBank(500 - 15));
    await settle(250);
    await shot('29-forge.png');
    await page.keyboard.press('Escape');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'), 1500);
  });

  await step('chest: opening a chest (touch "Ouvrir") grants a relic shown in the HUD', async () => {
    const i = await G(() => {
      const g = window.__gouffre, cs = g.game.entities.chests;
      let best = 0;
      for (let k = 0; k < cs.length; k++) if (cs[k].depth < cs[best].depth) best = k;
      cs[best].kind = 'relic';
      return best;
    });
    await G((i) => { const g = window.__gouffre; g.teleportToChest(i); g.clearEnemies(); }, i);
    // (wait for the label too: right after the Forge step the button may still say "Forge" for a frame)
    const btn = await waitFor(async () => { const l = await G(() => window.__gouffre.input.layout()); return l.interact.hidden || (await G(() => document.querySelector('.tbtn-ctx').textContent)) !== 'Ouvrir' ? null : l.interact; }, 2000);
    assert.equal(await G(() => document.querySelector('.tbtn-ctx').textContent), 'Ouvrir');
    await settle(300);
    const hudPx = () => G(() => {
      const game = window.__gouffre.game, R = game.renderer;
      const L = Math.max(6, game.safe.l + 4), T = Math.max(5, game.safe.t + 4);
      const d = R.ctx.getImageData(L, T + 23, 10, 10).data;
      let bright = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] > 420) bright++;
      return bright;
    });
    const before = await hudPx();
    await touch('touchStart', [{ x: btn.x, y: btn.y, id: 22 }]);
    await touch('touchEnd', []);
    await waitFor(async () => (await G(() => window.__gouffre.run())).relics.length === 1, 1500);
    assert.equal((await G(() => window.__gouffre.chests()))[i].opened, true);
    await settle(400);
    const after = await hudPx();
    assert.ok(after > before + 6, `relic icon drawn in the HUD (${before} -> ${after} bright px)`);
    await shot('31-relic-hud.png');
  });

  await step('camp: a hurt hero heals at the camp; late coins join the same tally and trip; the bag estimate restarts', async () => {
    await G(() => { const g = window.__gouffre; g.setGod(false); g.clearEnemies(); g.teleportDepth(20); g.giveOre('copper', 3); g.game.player.hp = 7; });
    await settle(200);
    const trips0 = (await G(() => window.__gouffre.save())).stats.trips;
    await G(() => window.__gouffre.teleport(31, 13));                 // back on the camp ground
    await waitFor(async () => (await G(() => window.__gouffre.run())).bagCount === 0, 2000, 30);
    await G(() => window.__gouffre.spawnCoins(0, 9, 3));             // coins still flying in
    await waitFor(() => G(() => window.__gouffre.game.hud.tallyData && window.__gouffre.game.hud.tallyData.total === 15), 3000, 30);
    await settle(300);
    await shot('36-camp-rest-tally.png');
    assert.equal((await G(() => window.__gouffre.save())).stats.trips, trips0 + 1, 'one trip, not one per coin');
    await waitFor(async () => { const p = await player(); return p.hp >= (await G(() => window.__gouffre.stats())).maxHp; }, 5000, 50);
    // next trip: one coal -> the estimate is 1 (it used to carry the previous trips' value)
    await G(() => { const g = window.__gouffre; g.teleportDepth(20); g.giveOre('coal', 1); });
    assert.equal((await G(() => window.__gouffre.run())).bagValue, 1);
  });

  await step('pause during the death animation goes straight to the death summary', async () => {
    await G(() => { const g = window.__gouffre; g.setGod(false); g.clearEnemies(); g.die('slime'); });
    await settle(250);
    assert.equal(await G(() => window.__gouffre.state), 'PLAYING', 'death animation playing');
    const lay = await G(() => window.__gouffre.input.layout());
    await touch('touchStart', [{ x: lay.pause.x, y: lay.pause.y, id: 24 }]);
    await touch('touchEnd', []);
    await waitFor(() => G(() => window.__gouffre.state === 'DEAD'), 1000);
    assert.equal(await G(() => window.__gouffre.ui()), 'death');
    await page.tap('[data-act=restart]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
  });

  await step('pause: "Recommencer l\'expédition" asks, then counts as a death (summary) and regenerates', async () => {
    const seed0 = (await G(() => window.__gouffre.gen())).seed;
    const deaths0 = (await G(() => window.__gouffre.save())).stats.deaths;
    const lay = await G(() => window.__gouffre.input.layout());
    await touch('touchStart', [{ x: lay.pause.x, y: lay.pause.y, id: 23 }]);
    await touch('touchEnd', []);
    await waitFor(() => G(() => window.__gouffre.state === 'PAUSED'));
    await page.tap('[data-act=abandon]');
    await page.waitForSelector('[data-act=abandon-confirm]');
    await shot('32-abandon-confirm.png');
    await page.tap('[data-act=abandon-confirm]');
    await waitFor(() => G(() => window.__gouffre.state === 'DEAD'));
    assert.match(await G(() => document.querySelector('[data-ui=death]').innerText), /abandonnée/i);
    assert.equal((await G(() => window.__gouffre.save())).stats.deaths, deaths0 + 1);
    await page.tap('[data-act=restart]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    assert.notEqual((await G(() => window.__gouffre.gen())).seed, seed0);
  });

  await step('touch: menu buttons answer while a thumb rests on the stick; a double tap never confirms abandon / erase', async () => {
    const center = (sel) => G((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const lay = await G(() => window.__gouffre.input.layout());
    const S = { x: 150, y: 250, id: 41 };
    await touch('touchStart', [S]);
    await touch('touchMove', [{ ...S, x: 175 }]);
    await touch('touchStart', [{ ...S, x: 175 }, { x: lay.pause.x, y: lay.pause.y, id: 42 }]);
    await touch('touchEnd', [{ x: lay.pause.x, y: lay.pause.y, id: 42 }]);
    await waitFor(() => G(() => window.__gouffre.state === 'PAUSED'));
    const r = await center('[data-act=resume]');
    await touch('touchStart', [{ ...S, x: 175 }, { x: r.x, y: r.y, id: 43 }]);
    await touch('touchEnd', [{ x: r.x, y: r.y, id: 43 }]);             // the stick thumb stays down
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'), 1000);
    await touch('touchEnd', []);
    // double tap on "Recommencer l'expédition": the confirm panel opens, nothing is abandoned
    const deaths0 = (await G(() => window.__gouffre.save())).stats.deaths;
    await G(() => window.__gouffre.pause());
    await settle(100);
    const ab = await center('[data-act=abandon]');
    for (let i = 0; i < 2; i++) { await touch('touchStart', [{ ...ab, id: 44 + i }]); await touch('touchEnd', []); await page.waitForTimeout(110); }
    await settle(200);
    assert.equal(await G(() => window.__gouffre.state), 'PAUSED', 'still paused');
    assert.equal((await G(() => window.__gouffre.save())).stats.deaths, deaths0, 'no abandon');
    const order = await G(() => [...document.querySelectorAll('.row.confirm button')].map((b) => b.dataset.act));
    assert.deepEqual(order, ['cancel', 'abandon-confirm'], '"Annuler" comes first');
    await page.tap('[data-act=cancel]');
    // settings: a double tap on "Effacer la sauvegarde" erases nothing
    await page.tap('[data-act=title]');
    await waitFor(() => G(() => window.__gouffre.state === 'TITLE'));
    const gold0 = (await G(() => window.__gouffre.save())).gold;
    await G(() => window.__gouffre.setBank(4321));
    await page.tap('[data-act=settings]');
    const er = await center('[data-act=erase]');
    for (let i = 0; i < 3; i++) { await touch('touchStart', [{ ...er, id: 50 + i }]); await touch('touchEnd', []); await page.waitForTimeout(120); }
    await settle(150);
    assert.equal((await G(() => JSON.parse(localStorage.getItem('gouffre.save.v1')))).gold, 4321, 'save intact after a triple tap');
    await shot('37-erase-confirm-armed.png');
    const danger = await G(() => { const b = document.querySelector('[data-act=erase-confirm]'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    if (danger) assert.ok(er.y < danger.top - 16 || er.y > danger.bottom + 16, 'the red button is not under the finger');
    if (await page.$('[data-act=cancel]')) await page.tap('[data-act=cancel]');
    await G((g0) => window.__gouffre.setBank(g0), gold0);
    await page.tap('[data-act=back]');
    await page.tap('button[data-act=play]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
  });

  await step('gamepad: a button held through a state change never confirms the next menu; D-pad / B navigate', async () => {
    await G(() => {
      window.__pad = { connected: true, id: 'mock', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), mapping: 'standard' };
      Object.defineProperty(navigator, 'getGamepads', { value: () => [window.__pad], configurable: true });
    });
    const btn = (i, v) => G(([i, v]) => { window.__pad.buttons[i].pressed = v; }, [i, v]);
    await settle(100);
    await btn(0, true);                         // A held (jump)
    await settle(100);
    await btn(9, true); await settle(120); await btn(9, false); // Start
    await settle(250);
    assert.equal(await G(() => window.__gouffre.state), 'PAUSED', 'the held A did not press "Reprendre"');
    await btn(0, false);
    await settle(80);
    for (let i = 0; i < 2; i++) { await btn(13, true); await settle(60); await btn(13, false); await settle(60); }
    assert.equal(await G(() => document.activeElement && document.activeElement.dataset.act), 'mute', 'D-pad moved the focus');
    await btn(1, true); await settle(80); await btn(1, false);  // B = back
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'), 1000);
    await G(() => { delete navigator.getGamepads; });
    await settle(100);
  });

  await step('menus: every button is at least 44 px tall; the pickaxe card shows the rock it unlocks', async () => {
    await G(() => window.__gouffre.pause());
    await settle(100);
    const small = await G(() => [...document.querySelectorAll('#ui button')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.dataset.act));
    assert.deepEqual(small, [], 'pause menu targets');
    await page.tap('[data-act=resume]');
    const pick0 = (await G(() => window.__gouffre.save())).upgrades.pick;
    await G(() => { const game = window.__gouffre.game; game.save.upgrades.pick = 3; game.setState('SHOP'); });
    await settle(200);
    const nx = await G(() => {
      const e = document.querySelector('[data-up=pick] .nx'), c = e.closest('.card');
      return { text: e.textContent, clipped: e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1 };
    });
    assert.match(nx.text, /Basalte, obsidienne/);
    assert.equal(nx.clipped, false, `"${nx.text}" fully visible`);
    const fits = await G(() => { const g = document.querySelector('.forge-grid'); return g.scrollHeight <= g.clientHeight + 1; });
    assert.ok(fits, 'the Forge still fits without scrolling');
    await shot('38-forge-unlock.png');
    await G((p0) => { const game = window.__gouffre.game; game.save.upgrades.pick = p0; game.setState('PLAYING'); game.refreshStats(); }, pick0);
  });

  await step('reload keeps the save; settings erase it only after a confirmation', async () => {
    await page.reload();
    await page.waitForSelector('button[data-act=play]', { timeout: 5000 });
    const sv = await G(() => window.__gouffre.save());
    assert.equal(sv.upgrades.bag, 1);
    assert.equal(sv.stats.victories, 1);
    assert.equal(sv.ngPlus, 1);
    assert.ok(sv.stats.deaths >= 2 && sv.stats.runs >= 3);
    await page.tap('[data-act=settings]');
    await page.tap('[data-act=erase]');
    await page.waitForSelector('[data-act=erase-confirm]');
    assert.equal((await G(() => window.__gouffre.save())).gold, sv.gold, 'nothing erased before confirming');
    await shot('33-erase-confirm.png');
    await page.tap('[data-act=erase-confirm]');
    const after = await G(() => window.__gouffre.save());
    assert.deepEqual([after.gold, after.upgrades.bag, after.stats.victories, after.ngPlus], [0, 0, 0, 0]);
    assert.equal((await G(() => JSON.parse(localStorage.getItem('gouffre.save.v1')))).gold, 0);
    await page.tap('[data-act=back]');
    assert.match(await G(() => document.querySelector('button[data-act=play]').innerText), /Jouer/i);
    await page.tap('button[data-act=play]');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    assert.equal((await G(() => window.__gouffre.stats())).bagCapacity, 10, 'upgrades reset');
  });

  await step('storage blocked (Safari "block all cookies"): a notice says progress will not be kept', async () => {
    const ctx3 = await browser.newContext({ ...pw.devices['iPhone 13 landscape'] });
    await ctx3.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    const p3 = await ctx3.newPage();
    const errs = [];
    p3.on('pageerror', (e) => errs.push(e.message));
    await p3.goto(`${url}/index.html?seed=12345&mute`);
    await p3.waitForSelector('.ui-notice', { timeout: 5000 });
    assert.match(await p3.evaluate(() => document.querySelector('.ui-notice').textContent), /Stockage indisponible/);
    await p3.screenshot({ path: resolve(SHOTS, '39-storage-notice.png') });
    await ctx3.close();
    assert.deepEqual(errs, []);
  });

  await step('zero console errors and page errors', async () => {
    const internal = await G(() => window.__gouffre.errors);
    assert.deepEqual(pageErrors, [], 'page errors');
    assert.deepEqual(consoleErrors, [], 'console errors');
    assert.deepEqual(internal, [], 'window errors');
  });
  await step('title logo follows the rotation after a portrait (home-screen) boot', async () => {
    const ctx2 = await browser.newContext({ ...pw.devices['iPhone 13'] });
    const p2 = await ctx2.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(`${url}/index.html?seed=12345&mute`);
    await p2.waitForSelector('.pixel-logo', { timeout: 5000 });
    const logoSize = () => p2.evaluate(() => { const c = document.querySelector('.pixel-logo'); return { w: c.style.width, h: c.style.height }; });
    const portrait = await logoSize();
    await p2.setViewportSize({ width: 750, height: 342 });
    await p2.waitForTimeout(600);
    const rotated = await logoSize();
    await p2.screenshot({ path: resolve(SHOTS, '14-title-after-rotate.png') });
    await ctx2.close();
    const landscape = await G(() => { const s = Math.max(4, Math.min(9, Math.floor(Math.min(window.innerWidth / 70, window.innerHeight / 30)))); return s; });
    assert.notDeepEqual(rotated, portrait, 'logo resized on rotation');
    assert.equal(rotated.h, `${13 * landscape}px`, 'same size as a landscape boot');
    assert.deepEqual(errs, []);
  });
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + results.join('\n'));
console.log(`\n# e2e: ${results.length - failed} passed, ${failed} failed — screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
