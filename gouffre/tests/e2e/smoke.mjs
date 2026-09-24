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

  await step('death leads to the death screen and a fresh run', async () => {
    const seed0 = (await G(() => window.__gouffre.gen())).seed;
    await G(() => window.__gouffre.game.player.takeDamage(9999));
    assert.equal((await player()).dead, true);
    await waitFor(() => G(() => window.__gouffre.state === 'DEAD'), 4000);
    await settle(150);
    await shot('12-death.png');
    await page.tap('text=Redescendre');
    await waitFor(() => G(() => window.__gouffre.state === 'PLAYING'));
    const p = await player();
    assert.equal(p.dead, false);
    assert.equal(p.hp, p.maxHp);
    assert.ok(p.feetY <= SURFACE_Y * TILE, 'back at the camp');
    assert.notEqual((await G(() => window.__gouffre.gen())).seed, seed0, 'new mine');
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
