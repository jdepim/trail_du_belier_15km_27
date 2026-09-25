// Pickups (ore chunks, coins, hearts) and chests (DESIGN.md §2, §6-§7).
//
//   EntityManager(game)
//     reset(gen)                        new world: chest records, empty pickup pool
//     onTileBroken(tx, ty, id)          called by game.tileBroken() -> spawnDrop()
//     spawnDrop(drop, x, y, def)        'heal' -> heart pickup; 'ore:<key>' -> ore chunk(s) for the bag
//     spawnOre(x, y, key)               one ore chunk (1 bag unit worth the tile's value)
//     spawnCoins(x, y, value, opts)     enemy / chest loot: value split over several coins
//     spawnHeart(x, y, heal)            healing heart
//     update(dt) / draw(ctx, camX, camY, alpha)
//     interactionAt(player)             { label: 'Ouvrir', use() } near a closed chest, else null
//     hitChests(box)                    a pickaxe strike opens the chests it touches
//     openChest(chest)                  relic (weighted by depth, never a duplicate) or gold
//     collectAllCoins()                 every coin on the ground -> run gold (victory)
//     pickups (fixed pool), popups (floating "+N" texts, fixed pool), chests
//
// Pickups are pooled (no allocation per drop): they pop out of their source,
// bounce on the tiles, are magnetised to the player after a short delay and are
// collected on touch. Coins go straight to the run gold (`game.run.gold`, banked at
// the camp or lost on death); ore chunks go to the backpack (`game.run.bag`, up to
// player.stats.bagCapacity units: when it is full they stay on the ground and the
// player gets "Sac plein !"); hearts heal (only when hurt; otherwise they wait).
// Pickups farther than DROPS.activeScreens views from the camera sleep.
import { TILE, DROPS, ECONOMY } from './config.js';
import { TILES, TILE_BY_KEY } from './tiles.js';
import { moveAndCollide } from './physics.js';
import { drawSprite } from './sprites.js';
import { drawText } from './hud.js';
import { RELICS, rollRelic } from './meta.js';

const K_COIN = 1, K_HEART = 2, K_ORE = 3;
const SIZE = { [K_COIN]: [5, 5], [K_HEART]: [7, 6], [K_ORE]: [5, 5] };
const MAX_POPUPS = 16;
const MAX_FX = 6;
// sprite names precomputed (drawing never builds strings)
const ORE_SPR = {};
for (const def of TILES) if (def.ore) ORE_SPR[def.key] = 'ore_' + def.key;

export class EntityManager {
  constructor(game) {
    this.game = game;
    this.chests = [];
    this.pickups = [];
    for (let i = 0; i < DROPS.maxPickups; i++) {
      this.pickups.push({ active: false, kind: 0, x: 0, y: 0, w: 5, h: 5, vx: 0, vy: 0, prevX: 0, prevY: 0, t: 0, life: 0, value: 0, magnet: false, phase: 0, ore: null, spr: null, color: '' });
    }
    this.popups = [];
    for (let i = 0; i < MAX_POPUPS; i++) this.popups.push({ active: false, text: '', color: '', x: 0, y: 0, t: 0 });
    // chest FX: a relic icon rising out of an opened chest
    this.fx = [];
    for (let i = 0; i < MAX_FX; i++) this.fx.push({ active: false, spr: '', x: 0, y: 0, t: 0 });
    this.activeCount = 0;
    this.fullToastT = 0;
    this._res = { onGround: false, hitCeiling: false, hitLeft: false, hitRight: false };
    this._seed = 0x2545f491;
    this._interChest = null;
    this._inter = { label: 'Ouvrir', use: () => { if (this._interChest) this.openChest(this._interChest); } };
  }

  _rand() {
    let x = this._seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._seed = x >>> 0;
    return this._seed / 4294967296;
  }

  /** New world: copy chest records from worldgen and drop every pickup. */
  reset(gen) {
    this.chests = gen && gen.chests ? gen.chests.map((c) => ({ ...c, opened: false, shake: 0 })) : [];
    for (const p of this.pickups) p.active = false;
    for (const p of this.popups) p.active = false;
    for (const f of this.fx) f.active = false;
    this.activeCount = 0;
    this.fullToastT = 0;
    this._interChest = null;
    if (gen && gen.seed !== undefined) this._seed = ((gen.seed >>> 0) ^ 0x2545f491) || 1;
  }

  /** Called by game.tileBroken(): spawn whatever the tile drops. */
  onTileBroken(tx, ty, tileId) {
    const def = TILES[tileId];
    if (!def || !def.drop) return;
    this.spawnDrop(def.drop, tx * TILE + TILE / 2, ty * TILE + TILE / 2, def);
  }

  /** drop: 'heal' (life crystal -> big heart) | 'ore:<key>' (chunks for the backpack). */
  spawnDrop(drop, x, y, def) {
    if (drop === 'heal') { this.spawnHeart(x, y, DROPS.crystalHeal); return; }
    if (def && def.ore) for (let i = 0; i < ECONOMY.oreChunksPerTile; i++) this.spawnOre(x, y, def.key);
  }

  _alloc() {
    const list = this.pickups;
    for (let i = 0; i < list.length; i++) if (!list[i].active) return list[i];
    // pool full: recycle the oldest pickup
    let old = list[0];
    for (let i = 1; i < list.length; i++) if (list[i].t > old.t) old = list[i];
    return old;
  }

  _spawn(kind, x, y, value, vx, vy) {
    const p = this._alloc();
    const [w, h] = SIZE[kind];
    p.active = true; p.kind = kind; p.w = w; p.h = h;
    p.x = x - w / 2; p.y = y - h / 2; p.prevX = p.x; p.prevY = p.y;
    p.vx = vx; p.vy = vy; p.t = 0; p.value = value; p.magnet = false;
    p.life = kind === K_ORE ? DROPS.oreLife : DROPS.life;
    p.ore = null; p.spr = null;
    p.phase = Math.floor(this._rand() * 4);
    return p;
  }

  /** One ore chunk (1 bag unit) popping out of a broken ore tile. */
  spawnOre(x, y, key) {
    const def = TILE_BY_KEY[key];
    if (!def || !def.ore) return null;
    const a = -Math.PI / 2 + (this._rand() - 0.5) * 1.4;
    const sp = 60 + this._rand() * 60;
    const p = this._spawn(K_ORE, x, y, def.value, Math.cos(a) * sp, Math.sin(a) * sp - 30);
    p.ore = key; p.spr = ORE_SPR[key]; p.color = def.colors[3];
    return p;
  }

  /**
   * Coins dropped by enemies / chests: `value` gold split over `opts.count` coins
   * (default: 1 coin per ~3 gold, at most DROPS.coinsMax). Every coin is worth >= 1.
   */
  spawnCoins(x, y, value, opts = {}) {
    value = Math.max(1, Math.round(value));
    const n = Math.max(1, Math.min(value, opts.count ?? Math.min(DROPS.coinsMax, Math.ceil(value / 3))));
    const base = Math.floor(value / n);
    let extra = value - base * n;
    for (let i = 0; i < n; i++) {
      const v = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      const a = -Math.PI / 2 + (this._rand() - 0.5) * 1.6;
      const sp = 70 + this._rand() * 80;
      this._spawn(K_COIN, x, y, v, Math.cos(a) * sp, Math.sin(a) * sp - 40);
    }
  }

  /** Healing heart (enemy drop, life crystal, boss). */
  spawnHeart(x, y, heal = DROPS.heartHeal) {
    this._spawn(K_HEART, x, y, heal, (this._rand() - 0.5) * 60, -150);
  }

  /** Floating "+N" text (pooled). */
  popup(text, x, y, color) {
    let p = null;
    for (const q of this.popups) if (!q.active) { p = q; break; }
    if (!p) { p = this.popups[0]; for (const q of this.popups) if (q.t > p.t) p = q; }
    // stack instead of overlapping a fresh popup at the same spot (two ore chunks at once)
    for (let k = 0; k < 4; k++) {
      let clash = false;
      for (const q of this.popups) if (q.active && q !== p && q.t < 0.5 && Math.abs(q.x - x) < 28 && Math.abs(q.y - y) < 7) { clash = true; break; }
      if (!clash) break;
      y -= 8;
    }
    p.active = true; p.text = text; p.color = color; p.x = x; p.y = y; p.t = 0;
  }

  _bagFull() {
    const run = this.game.run;
    return !run || (run.bagCount || 0) >= this.game.player.stats.bagCapacity;
  }

  _toastFull() {
    if (this.fullToastT > 0) return;
    this.fullToastT = DROPS.fullToastCooldown;
    this.game.toast('Sac plein !', { color: '#ff9a6a', sub: 'Remonte au camp pour mettre ton butin à l’abri' });
    this.game.audio.play('clink', { pitch: 0.7 });
  }

  update(dt) {
    const g = this.game, pl = g.player, world = g.world;
    const pcx = pl.cx, pcy = pl.cy;
    const mr = DROPS.magnetRadius * (pl.stats.magnetMul || 1);
    const cam = g.camera;
    const ccx = cam ? cam.x + cam.viewW / 2 : pcx, ccy = cam ? cam.y + cam.viewH / 2 : pcy;
    const rx = cam ? cam.viewW * DROPS.activeScreens : Infinity, ry = cam ? cam.viewH * DROPS.activeScreens : Infinity;
    this.fullToastT -= dt;
    let n = 0;
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
      if (!p.active) continue;
      n++;
      p.prevX = p.x; p.prevY = p.y;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      // far from the camera: sleep (unless already flying to the player)
      if (!p.magnet && (Math.abs(cx - ccx) > rx || Math.abs(cy - ccy) > ry)) continue;
      p.t += dt;
      if (p.t >= p.life) { p.active = false; continue; }
      const dx = pcx - cx, dy = pcy - cy;
      const d2 = dx * dx + dy * dy;
      // re-checked for every pickup: two chunks / hearts collected in the same tick must
      // not overfill the backpack or waste a heart on full HP
      const wanted = p.kind === K_HEART ? pl.hp < pl.stats.maxHp : p.kind === K_ORE ? !this._bagFull() : true;
      if (!pl.dead && wanted && p.t > DROPS.magnetDelay && (p.magnet || d2 < mr * mr)) {
        // magnetised: fly to the player through everything
        p.magnet = true;
        const d = Math.sqrt(d2) || 1;
        p.vx += (dx / d) * DROPS.magnetAccel * dt;
        p.vy += (dy / d) * DROPS.magnetAccel * dt;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > DROPS.magnetMaxSpeed) { p.vx *= DROPS.magnetMaxSpeed / sp; p.vy *= DROPS.magnetMaxSpeed / sp; }
        // steer: bleed the sideways component so it does not orbit
        p.vx += (dx / d * sp - p.vx) * Math.min(1, 6 * dt);
        p.vy += (dy / d * sp - p.vy) * Math.min(1, 6 * dt);
        p.x += p.vx * dt; p.y += p.vy * dt;
      } else {
        if (p.magnet) { p.magnet = false; p.vx *= 0.3; p.vy = Math.min(p.vy, 0); } // bag got full mid-flight
        p.vy = Math.min(DROPS.gravity * 0.6, p.vy + DROPS.gravity * dt);
        const vy0 = p.vy, vx0 = p.vx;
        const res = moveAndCollide(p, dt, world, this._res);
        if (res.onGround) {
          if (vy0 > 60) p.vy = -vy0 * DROPS.bounce; // bounce
          p.vx *= Math.max(0, 1 - 7 * dt);          // ground friction
          if (Math.abs(p.vx) < 2) p.vx = 0;
        }
        if (res.hitLeft || res.hitRight) p.vx = -vx0 * 0.5;
        if (res.hitCeiling) p.vy = Math.abs(vy0) * 0.3;
      }
      // collect on touch (slightly generous box)
      if (!pl.dead && p.t > 0.12 &&
          p.x < pl.x + pl.w + 3 && p.x + p.w > pl.x - 3 && p.y < pl.y + pl.h + 2 && p.y + p.h > pl.y - 2) {
        if (wanted) this._collect(p);
        else if (p.kind === K_ORE) this._toastFull();
      }
    }
    this.activeCount = n;
    for (const q of this.popups) {
      if (!q.active) continue;
      q.t += dt;
      q.y -= 18 * dt;
      if (q.t > 0.9) q.active = false;
    }
    for (const f of this.fx) {
      if (!f.active) continue;
      f.t += dt;
      f.y -= Math.max(0, 22 - f.t * 18) * dt;
      if (f.t > 2.2) f.active = false;
    }
    for (const c of this.chests) if (c.shake > 0) c.shake -= dt;
  }

  _collect(p) {
    const g = this.game, pl = g.player, run = g.run;
    p.active = false;
    const x = p.x + p.w / 2, y = p.y + p.h / 2;
    if (p.kind === K_COIN) {
      const v = Math.max(1, Math.round(p.value * (pl.stats.goldMul || 1)));
      if (run) run.gold = (run.gold || 0) + v;
      g.audio.play('coin', { pitch: 0.95 + this._rand() * 0.2 });
      g.particles.spawn('glint', x, y, { color: '#fff3a3' });
      this.popup('+' + v, x, pl.y - 4, '#ffe08a');
    } else if (p.kind === K_HEART) {
      const healed = pl.heal(p.value);
      g.audio.play('heal', {});
      g.particles.spawn('glint', x, y, { color: '#ffd0dc' });
      g.particles.spawn('blood', x, y, { count: 5, color: '#ff7a95' });
      this.popup('+' + healed + ' PV', x, pl.y - 4, '#ff8aa0');
    } else if (p.kind === K_ORE && run) {
      run.bag[p.ore] = (run.bag[p.ore] || 0) + 1;
      run.bagCount = (run.bagCount || 0) + 1;
      run.bagValue = (run.bagValue || 0) + p.value;
      const def = TILE_BY_KEY[p.ore];
      g.audio.play('pickup', { pitch: 0.85 + Math.min(0.6, p.value / 80) });
      g.particles.spawn('glint', x, y, { color: p.color });
      this.popup(def.name, x, pl.y - 4, p.color);
      if (run.bagCount >= pl.stats.bagCapacity) { this.fullToastT = 0; this._toastFull(); }
    }
  }

  /** Every coin on the ground goes to the run gold (the Guardian's treasure at victory). */
  collectAllCoins() {
    let total = 0;
    for (const p of this.pickups) if (p.active && p.kind === K_COIN) { total += p.value; this._collect(p); }
    return total;
  }

  // ---------------------------------------------------------------- chests

  _chestNear(player) {
    let best = null, bestD = Infinity;
    for (const c of this.chests) {
      if (c.opened) continue;
      const dx = Math.abs(c.x - player.cx);
      if (dx > ECONOMY.chestInteract || Math.abs(c.y - player.feetY) > 14) continue;
      if (dx < bestD) { bestD = dx; best = c; }
    }
    return best;
  }

  /** Nearest interactable for the contextual button: { label, use() } | null (object reused). */
  interactionAt(player) {
    if (player.dead) return null;
    this._interChest = this._chestNear(player);
    return this._interChest ? this._inter : null;
  }

  /** A pickaxe strike box ({x,y,w,h}) opens the closed chests it touches. Returns how many. */
  hitChests(box) {
    let n = 0;
    for (const c of this.chests) {
      if (c.opened) continue;
      // chest footprint: 14 × 10 px, (x, y) = centre-bottom
      if (box.x < c.x + 7 && box.x + box.w > c.x - 7 && box.y < c.y && box.y + box.h > c.y - 10) { this.openChest(c); n++; }
    }
    return n;
  }

  /** Open a chest: a relic (weighted by layer, never a duplicate) or a burst of gold. */
  openChest(c) {
    if (!c || c.opened) return null;
    const g = this.game, run = g.run;
    c.opened = true; c.shake = 0.25;
    if (run) run.chests = (run.chests || 0) + 1;
    const x = c.x, y = c.y - 8;
    g.audio.play('chest', {});
    g.particles.spawn('glint', x, y, { color: '#fff0a0' });
    g.particles.spawn('spark', x, y, { count: 8 });
    g.particles.spawn('dust', x, c.y, { count: 4 });
    g.camera.shake(1.5, 0.12);
    const owned = run ? run.relics : [];
    const key = c.kind === 'relic' ? rollRelic(() => this._rand(), c.layer, owned) : null;
    if (key) {
      const r = RELICS[key];
      if (run) run.relics.push(key);
      if (g.refreshStats) g.refreshStats();
      const f = this.fx.find((q) => !q.active) || this.fx[0];
      f.active = true; f.spr = r.icon; f.x = x; f.y = y - 4; f.t = 0;
      g.particles.spawn('glint', x, y - 6, { color: '#e8c878' });
      g.toast('Relique : ' + r.name, { color: '#e8c878', sub: r.desc, life: 3.2, icon: r.icon });
      if (g.hud && g.hud.flash) g.hud.flash('#fff0c0', 0.25);
      return { relic: key };
    }
    const value = Math.round(ECONOMY.chestGoldBase * (1 + (c.depth || 0) * ECONOMY.chestGoldPerM));
    this.spawnCoins(x, y, value, { count: ECONOMY.chestCoins });
    g.toast('Trésor !', { color: '#ffe08a', sub: `${value} pièces d’or` });
    return { gold: value };
  }

  draw(ctx, camX, camY, alpha = 1) {
    const vw = ctx.canvas.width, vh = ctx.canvas.height;
    const time = this.game.time;
    for (const c of this.chests) {
      const sx = Math.round(c.x - camX), sy = Math.round(c.y - camY);
      if (sx < -24 || sy < -24 || sx > vw + 24 || sy > vh + 24) continue;
      const jig = c.shake > 0 ? (Math.floor(c.shake * 40) % 2 ? 1 : -1) : 0;
      drawSprite(ctx, c.opened ? 'chest_open' : 'chest', 0, sx + jig, sy);
      // closed chests glint now and then so they read in the dark
      if (!c.opened && ((time * 1.3 + c.tx * 0.37) % 2.4) < 0.18) {
        ctx.fillStyle = '#fff6c8';
        ctx.fillRect(sx - 1 + (c.tx % 5) - 2, sy - 8, 1, 1);
        ctx.fillRect(sx - 2 + (c.tx % 5) - 2, sy - 7, 3, 1);
        ctx.fillRect(sx - 1 + (c.tx % 5) - 2, sy - 6, 1, 1);
      }
    }
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
      if (!p.active) continue;
      const left = p.life - p.t;
      if (left < 3 && Math.floor(left * 8) % 2 === 0) continue; // blink before vanishing
      const x = Math.round(p.prevX + (p.x - p.prevX) * alpha + p.w / 2) - camX;
      const y = Math.round(p.prevY + (p.y - p.prevY) * alpha + p.h) - camY;
      if (x < -8 || y < -8 || x > vw + 8 || y > vh + 8) continue;
      if (p.kind === K_COIN) drawSprite(ctx, 'coin', Math.floor(time * 10) + p.phase, x, y);
      else if (p.kind === K_ORE) {
        drawSprite(ctx, p.spr, 0, x, y);
        if (((time * 2 + p.phase * 0.5) % 1.6) < 0.12) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 1, y - 4, 1, 1); }
      } else drawSprite(ctx, 'heart', Math.floor(time * 3) % 2, x, y - (Math.floor(time * 3) % 2));
    }
    for (const f of this.fx) {
      if (!f.active) continue;
      const a = Math.min(1, (2.2 - f.t) / 0.5);
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * a;
      // halo
      ctx.fillStyle = '#e8c878';
      ctx.globalAlpha = prev * a * 0.25;
      ctx.fillRect(Math.round(f.x - camX) - 7, Math.round(f.y - camY) - 11, 14, 14);
      ctx.globalAlpha = prev * a;
      drawSprite(ctx, f.spr, 0, Math.round(f.x - camX), Math.round(f.y - camY));
      ctx.globalAlpha = prev;
    }
    for (const q of this.popups) {
      if (!q.active) continue;
      drawText(ctx, q.text, Math.round(q.x - camX), Math.round(q.y - camY), q.color, { align: 'center', outline: '#07040c', alpha: Math.min(1, (0.9 - q.t) / 0.3) });
    }
  }

  get pickupCount() { return this.activeCount; }
}
