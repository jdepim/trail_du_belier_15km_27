// Debug flags (?debug, ?god, ?seed=, ?depth=, ?gold=, ?bank=, ?autostart, ?mute, ?canvasscale) and the
// window.__gouffre handle used by the end-to-end tests.
import { TILE, SURFACE_Y, FIXED_DT, ENEMY_SPAWN_RULES } from './config.js';
import { TILES, TILE_ID, SOLID } from './tiles.js';

export function parseFlags(search) {
  const q = new URLSearchParams(search || '');
  const has = (k) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  const num = (k) => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
  return {
    debug: has('debug'),
    god: has('god'),
    seed: q.has('seed') ? q.get('seed') : null,
    depth: num('depth'),
    gold: num('gold'),
    bank: num('bank'),
    autostart: has('autostart'),
    mute: has('mute'),
    nosw: has('nosw') || has('debug'),
    canvasScale: has('canvasscale'), // fallback present path: upscale in a device-pixel canvas (render.js)
  };
}

/** Find (or carve) a standing spot near column `tx` at depth `d` metres. */
function standingSpot(world, tx, d) {
  const ty = Math.min(world.h - 14, SURFACE_Y + d);
  for (let r = 0; r < 20; r++) {
    for (const x of [tx + r, tx - r]) {
      if (x < 3 || x >= world.w - 3) continue;
      for (let y = ty - 6; y <= ty + 6; y++) {
        if (!SOLID[world.get(x, y)] && !SOLID[world.get(x, y - 1)] && SOLID[world.get(x, y + 1)] && world.get(x, y) !== TILE_ID.LAVA) return { tx: x, ty: y };
      }
    }
  }
  // nothing open: carve a 1x2 pocket on a floor
  world.set(tx, ty, TILE_ID.AIR); world.set(tx, ty - 1, TILE_ID.AIR);
  if (!SOLID[world.get(tx, ty + 1)]) world.set(tx, ty + 1, TILE_ID.STONE);
  return { tx, ty };
}

/** Plain snapshot of an enemy for the tests. */
function enemyInfo(e) {
  if (!e) return null;
  return {
    key: e.key, x: e.x, y: e.y, cx: e.x + e.w / 2, cy: e.y + e.h / 2, w: e.w, h: e.h, vx: e.vx, vy: e.vy,
    hp: e.hp, maxHp: e.maxHp, dmg: e.dmg, state: e.state, phase: e.phase, active: e.active, alive: e.alive,
    dying: e.dying > 0 || e.state === 'dying', depth: e.depth, facing: e.facing, minion: e.minion,
  };
}

export function installDebug(game) {
  const api = {
    game,
    get state() { return game.state; },
    errors: [],
    start(seed) { game.startGame(seed); return game.state; },
    newRun(seed) { game.newRun(seed); },
    pause() { game.setState('PAUSED'); },
    resume() { game.setState('PLAYING'); },
    /** Stop the real-time loop; use step(n) to advance deterministic fixed ticks. */
    freeze(b = true) { game.frozen = b; },
    step(n = 1) { for (let i = 0; i < n; i++) game.fixedStep(FIXED_DT); game.renderer.render(1); },
    input: {
      set(state) { game.input.inject(state); },
      tap(action) { game.input.tap(action); },
      clear() { game.input.clearInjected(); },
      layout() { return game.input.getLayout(); },
      get state() { const i = game.input; return { moveX: i.moveX, moveY: i.moveY, aimX: i.aimX, aimY: i.aimY, aimActive: i.aimActive, jump: i.raw.jump, attack: i.raw.attack, grapple: i.raw.grapple }; },
    },
    player() {
      const p = game.player;
      return {
        x: p.x, y: p.y, cx: p.cx, feetY: p.feetY, vx: p.vx, vy: p.vy, onGround: p.onGround, hp: p.hp, maxHp: p.stats.maxHp,
        facing: p.facing, anim: p.anim, frame: p.animFrame, tileX: p.tileX, tileY: p.tileY, depth: p.depth, dead: p.dead, iframes: p.iframes,
      };
    },
    grapple() {
      const gr = game.player.grapple;
      return { state: gr.state, anchorX: gr.anchorX, anchorY: gr.anchorY, anchorTx: gr.anchorTx, anchorTy: gr.anchorTy, length: gr.length, predicted: gr.predicted ? { x: gr.predicted.x, y: gr.predicted.y } : null };
    },
    tile(tx, ty) { const id = game.world.get(tx, ty); return { id, key: TILES[id].key, solid: !!SOLID[id], damage: game.world.damage[ty * game.world.w + tx] || 0 }; },
    setTile(tx, ty, key) { game.world.set(tx, ty, typeof key === 'number' ? key : TILE_ID[key.toUpperCase()]); },
    /** Teleport the player's feet to tile (tx, ty) (feet on top of row ty + 1). */
    teleport(tx, ty) { game.player.teleport(tx * TILE + TILE / 2, (ty + 1) * TILE); game.camera.snap(); },
    teleportDepth(d, tx = Math.floor(game.world.w / 2)) {
      const s = standingSpot(game.world, tx, d);
      api.teleport(s.tx, s.ty);
      return s;
    },
    setGod(b = true) { game.flags.god = b; },
    // ---- enemies & combat (step 2a)
    /**
     * Spawn an enemy next to the player: dx px beside its centre (walkers on the
     * player's floor, flyers at chest height). opts: { state, cd, anchor, y }
     */
    spawnEnemy(key, dx = 32, dy = 0, opts = {}) {
      const p = game.player;
      const rule = ENEMY_SPAWN_RULES[key];
      if (!rule) return null;
      const anchor = opts.anchor || (rule.anchor === 'floor' ? 'floor' : 'air');
      const y = opts.y ?? (anchor === 'floor' ? p.feetY : p.cy) + dy;
      const state = opts.state ?? (key === 'bat' && anchor !== 'ceiling' ? 'fly' : key === 'spider' && anchor !== 'ceiling' ? 'walk' : undefined);
      const e = game.enemies.spawn(key, p.cx + dx, y, { anchor, state });
      if (!e) return null;
      if (opts.cd !== undefined) e.cd = opts.cd;
      e.facing = dx >= 0 ? -1 : 1;
      return enemyInfo(e);
    },
    enemies(all = false) {
      return game.enemies.list.filter((e) => e.alive && (all || e.key !== 'guardian')).map(enemyInfo);
    },
    /** Kill every regular enemy silently (no drops); the Guardian stays. */
    clearEnemies() {
      for (const e of game.enemies.list) if (e.key !== 'guardian') e.alive = false;
      for (const pr of game.enemies.projectiles) pr.active = false;
    },
    boss() {
      const en = game.enemies, b = en.boss;
      const info = enemyInfo(b);
      return { enemy: info, bar: en.bossBar ? { ...en.bossBar } : null, gatesSealed: en.gatesSealed, defeated: en.bossDefeated };
    },
    /** Damage the Guardian directly (skips phase-change invulnerability checks only via hurt rules). */
    hurtBoss(dmg) { const b = game.enemies.boss; return b ? game.enemies.hurt(b, dmg, null, {}) : false; },
    pickups() {
      return game.entities.pickups.filter((p) => p.active).map((p) => ({ kind: p.kind === 1 ? 'coin' : p.kind === 3 ? 'ore' : 'heart', ore: p.ore, x: p.x, y: p.y, value: p.value, magnet: p.magnet }));
    },
    spawnCoins(dx, value, count) { const p = game.player; game.entities.spawnCoins(p.cx + dx, p.cy - 8, value, count ? { count } : {}); },
    run() {
      const r = game.run;
      return {
        seed: r.seed, gold: r.gold, kills: r.kills, bossDefeated: !!r.bossDefeated, ngPlus: r.ngPlus, over: !!r.over,
        bagCount: r.bagCount, bagValue: r.bagValue, bag: { ...r.bag }, relics: r.relics.slice(), banked: r.banked, time: r.time,
      };
    },
    // ---- economy & meta loop (step 2b)
    save() { return JSON.parse(JSON.stringify(game.save)); },
    setBank(n) { game.save.gold = n; game.persist(); if (game.ui.current && game.ui.current._refresh) game.ui.current._refresh(); },
    stats() { return { ...game.player.stats }; },
    ui() { return game.ui.name; },
    /** Ore chunks next to the player (dx px beside it). */
    spawnOre(dx = 12, key = 'copper', n = 1) { const p = game.player; for (let i = 0; i < n; i++) game.entities.spawnOre(p.cx + dx, p.cy - 6, key); },
    /** Put ore straight into the backpack (ignores the capacity). */
    giveOre(key = 'copper', n = 1) {
      const r = game.run, def = TILES[TILE_ID[key.toUpperCase()]];
      r.bag[key] = (r.bag[key] || 0) + n; r.bagCount += n; r.bagValue += def.value * n;
    },
    bank() { return game.bank(); },
    chests() { return game.entities.chests.map((c, i) => ({ i, tx: c.tx, ty: c.ty, x: c.x, y: c.y, kind: c.kind, layer: c.layer, depth: c.depth, opened: c.opened })); },
    /** Stand next to chest i (feet on its floor, 12 px to its left). */
    teleportToChest(i) { const c = game.entities.chests[i]; game.player.teleport(c.x - 12, c.y); game.camera.snap(); return api.chests()[i]; },
    giveRelic(key) { if (!game.run.relics.includes(key)) game.run.relics.push(key); game.refreshStats(); return game.run.relics.slice(); },
    /** Kill the Guardian now, whatever its phase (hurt() is phase-gated: one blow never skips a phase). */
    killBoss() { const b = game.enemies.boss; if (!b) return false; b.state = b.state === 'dormant' || b.state === 'intro' || b.state === 'phase' ? 'walk' : b.state; game.enemies.kill(b); return b.state === 'dying'; },
    die(cause = 'enemy') { const p = game.player; p.iframes = 0; const god = game.flags.god; game.flags.god = false; p.takeDamage(99999, null, { cause }); game.flags.god = god; },
    gen() { const g = game.gen; return { seed: g.seed, camp: g.camp, arena: g.arena, spawns: g.spawns.length, chests: g.chests.length }; },
    info() { return { scale: game.renderer.scale, W: game.renderer.W, H: game.renderer.H, fps: game.fps, safe: game.safe, touch: game.input.touchEnabled }; },
  };
  window.__gouffre = api;
  window.addEventListener('error', (e) => api.errors.push(String(e.message || e)));
  if (game.flags.debug) {
    game.input.onKeyDebug = (e) => {
      if (e.code === 'KeyG') { game.flags.god = !game.flags.god; game.toast(game.flags.god ? 'MODE DIEU' : 'MODE NORMAL'); }
      if (e.code === 'KeyN') api.teleportDepth(game.player.depth + 40, game.player.tileX);
      if (e.code === 'KeyB') api.teleportDepth(Math.max(0, game.player.depth - 40), game.player.tileX);
    };
  }
  return api;
}
