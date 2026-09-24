// Debug flags (?debug, ?god, ?seed=, ?depth=, ?gold=, ?autostart, ?mute) and the
// window.__gouffre handle used by the end-to-end tests.
import { TILE, SURFACE_Y, FIXED_DT } from './config.js';
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
    autostart: has('autostart'),
    mute: has('mute'),
    nosw: has('nosw') || has('debug'),
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
        facing: p.facing, anim: p.anim, frame: p.animFrame, tileX: p.tileX, tileY: p.tileY, depth: p.depth, dead: p.dead,
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
