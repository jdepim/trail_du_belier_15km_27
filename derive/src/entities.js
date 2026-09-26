// Everything the astronaut can pick up or use (DESIGN.md §5, §7): salvage / consumable pickups
// (pool, magnet), debris fields re-rolled every life, key items on pads, satellites, terminals,
// keycard doors, crates, the Orion refill station and locker, the workbench, the dock and the
// return capsule. No drawing: the renderer reads the public state documented in NOTES.md.
//
//   new Entities(game)
//     reset(gen, lifeSeed)        new life: world records + saved progress, debris re-rolled, pool refilled
//     update(dt)                  dock (deposit + refill), key items, pickups (magnet, collect), interactable
//     interact()                  use the current interactable (the Action button)
//     spawnSalvage(x, y, value)   burst of salvage pickups (crates, satellites, logs, asteroid fragments)
//     spawnPickup(kind, x, y, value, vx, vy, opts?) -> pickup | null
//     blastPush(x, y, r, power)   explosions push loose pickups
//   Public state: pickups (pool), items, satellites, terminals, doors, crates, refills, lockers,
//     workbench, capsule, dock, inDock, interactable ({ kind, label, x, y, ref } or null).
import { PICKUPS, ECONOMY, INTERACT, FOG } from './config.js';
import { TILE_ID } from './tiles.js';
import { moveCircle } from './physics.js';
import { mulberry32, hashString } from './rng.js';
import { depositSalvage } from './meta.js';

const LABEL = {
  door: 'Ouvrir', crate: 'Ouvrir', terminal: 'Lire', satellite: 'Activer', refill: 'Ravitailler',
  locker: 'Recharger', workbench: 'Établi', capsule: 'Embarquer',
};
const TOAST_WARN = { color: '#ffb347' };
const TOAST_INFO = { color: '#8fe3ff' };

export class Entities {
  constructor(game) {
    this.game = game;
    this.pickups = [];
    for (let i = 0; i < PICKUPS.pool; i++) {
      this.pickups.push({
        active: false, kind: 'salvage', value: 0, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0,
        r: PICKUPS.r, restitution: 0.5, friction: 0.2, magnet: false, loose: false, t: 0,
        cacheId: null, variant: 0, spin: 0, autoMagnet: false,
      });
    }
    this.items = []; this.satellites = []; this.terminals = []; this.doors = []; this.crates = [];
    this.refills = []; this.lockers = []; this.workbench = null; this.capsule = null; this.dock = null;
    this.inDock = false;
    this.interactable = null;
    this._inter = { kind: '', label: '', x: 0, y: 0, ref: null };
    this._best = Infinity;
    this._res = { hit: false, nx: 0, ny: 0, impact: 0, tile: 0 };
    this._g = { ax: 0, ay: 0, mag: 0, bh: 0 };
    this._fx = { vx: 0, vy: 0, nx: 0, ny: 0, count: 1, power: 1, r: 0, material: '', color: '' };
    this._snd = { volume: 1, pitch: 1, material: '' };
    this._rnd = mulberry32(1);
    this._spawnSeq = 0;
  }

  // ------------------------------------------------------------------ setup

  reset(gen, lifeSeed = 1) {
    const save = this.game.save || null;
    const w = save ? save.world : null;
    const has = (list, id) => !!(list && list.includes(id));
    this._rnd = mulberry32((lifeSeed ^ 0x9e11) >>> 0);
    this.dock = gen.dock;
    this.workbench = gen.workbench;
    this.capsule = gen.capsule;
    this.items = gen.items.map((i) => ({ id: i.id, key: i.key, x: i.x, y: i.y, taken: !!(save && save.items[i.key]) }));
    this.satellites = gen.satellites.map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y, active: has(w && w.satellites, s.id) }));
    this.terminals = gen.terminals.map((t) => ({ id: t.id, log: t.log, x: t.x, y: t.y, read: has(w && w.logs, t.log) }));
    const world = this.game.world;
    this.doors = gen.doors.map((d) => ({
      id: d.id, x: d.x, y: d.y, tiles: d.tiles, vertical: d.vertical, tx0: d.tx0, ty0: d.ty0, tx1: d.tx1, ty1: d.ty1,
      open: world.types[d.tiles[0]] !== TILE_ID.DOOR_LOCKED,
    }));
    this.crates = gen.crates.map((c) => ({ id: c.id, x: c.x, y: c.y, value: c.value, opened: has(w && w.crates, c.id) }));
    this.refills = gen.refills.map((r) => ({ id: r.id, x: r.x, y: r.y }));
    this.lockers = gen.lockers.map((l) => ({ id: l.id, x: l.x, y: l.y }));
    for (const p of this.pickups) p.active = false;
    this._spawnSeq = 0;
    // consumables placed in the plans: back every life
    for (const p of gen.pickups) {
      const v = p.kind === 'o2' ? ECONOMY.o2Pickup : p.kind === 'fuel' ? ECONOMY.fuelPickup : ECONOMY.repairPickup;
      this.spawnPickup(p.kind, p.x, p.y, v, 0, 0, STATIC);
    }
    // one-time salvage caches
    for (const c of gen.caches) {
      if (has(w && w.taken, c.id)) continue;
      const pk = this.spawnPickup('salvage', c.x, c.y, c.value, 0, 0, STATIC);
      if (pk) { pk.cacheId = c.id; pk.variant = 3; }
    }
    // debris fields: re-rolled with the life seed
    for (const f of gen.debrisFields) {
      const rnd = mulberry32((lifeSeed ^ hashString(f.poi)) >>> 0);
      for (let i = 0; i < f.count; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(f.rMin * f.rMin + rnd() * (f.rMax * f.rMax - f.rMin * f.rMin));
        const x = f.x + Math.cos(a) * r, y = f.y + Math.sin(a) * r;
        const value = ECONOMY.debrisValue[0] + ((rnd() * (ECONOMY.debrisValue[1] - ECONOMY.debrisValue[0] + 1)) | 0);
        if (world.circleSolid(x, y, PICKUPS.r + 2)) continue;
        this.spawnPickup('salvage', x, y, value, 0, 0, STATIC);
      }
    }
    this.inDock = false;
    this.interactable = null;
  }

  // ------------------------------------------------------------------ pickups

  /** Take a pool slot (the oldest loose pickup is recycled when the pool is full). */
  spawnPickup(kind, x, y, value, vx = 0, vy = 0, opts = null) {
    let slot = null;
    for (const p of this.pickups) if (!p.active) { slot = p; break; }
    if (!slot) {
      for (const p of this.pickups) if (p.loose && !p.magnet && (!slot || p.t > slot.t)) slot = p;
      if (!slot) return null;
    }
    slot.active = true; slot.kind = kind; slot.value = value;
    slot.x = x; slot.y = y; slot.prevX = x; slot.prevY = y; slot.vx = vx; slot.vy = vy;
    slot.magnet = false; slot.loose = !(opts && opts.static); slot.t = 0; slot.cacheId = null;
    slot.autoMagnet = !!(opts && opts.burst);
    slot.variant = (this._spawnSeq++ * 7) & 3;
    slot.spin = ((this._spawnSeq * 37) % 100) / 100 * Math.PI * 2;
    return slot;
  }

  /** Burst of salvage worth `value` (pieces of 1–3) flying out of (x, y). */
  spawnSalvage(x, y, value) {
    let left = Math.max(0, Math.floor(value));
    while (left > 0) {
      const v = Math.min(left, left > 6 ? 3 : left > 3 ? 2 : 1);
      left -= v;
      const a = this._rnd() * Math.PI * 2, s = PICKUPS.burstSpeed * (0.4 + this._rnd() * 0.6);
      if (!this.spawnPickup('salvage', x, y, v, Math.cos(a) * s, Math.sin(a) * s, BURST)) break;
    }
  }

  blastPush(x, y, r, power) {
    for (const p of this.pickups) {
      if (!p.active) continue;
      const dx = p.x - x, dy = p.y - y;
      const d = Math.hypot(dx, dy);
      if (d >= r || d === 0) continue;
      const k = power * (1 - d / r);
      p.vx += (dx / d) * k; p.vy += (dy / d) * k;
      p.loose = true;
    }
  }

  /** Consumables are only taken when at least a quarter of their value would be used. */
  _wants(kind) {
    const pl = this.game.player, s = pl.stats;
    if (kind === 'o2') return pl.o2 <= s.o2Max - ECONOMY.o2Pickup * 0.25;
    if (kind === 'fuel') return pl.fuel <= s.fuelMax - ECONOMY.fuelPickup * 0.25;
    if (kind === 'repair') return pl.hull <= s.maxHull - ECONOMY.repairPickup * 0.25;
    return true;
  }

  _collect(p) {
    const g = this.game, pl = g.player, s = pl.stats;
    p.active = false;
    if (p.kind === 'salvage') {
      if (g.run) g.run.salvage += p.value;
      if (p.cacheId && g.save && !g.save.world.taken.includes(p.cacheId)) g.save.world.taken.push(p.cacheId);
      this._sound('pickup_salvage', 0.7, 0.9 + Math.min(0.5, p.value * 0.1));
    } else if (p.kind === 'o2') {
      pl.o2 = Math.min(s.o2Max, pl.o2 + p.value);
      this._sound('pickup_o2');
    } else if (p.kind === 'fuel') {
      pl.fuel = Math.min(s.fuelMax, pl.fuel + p.value);
      pl.fuelEmpty = pl.fuel <= 0;
      this._sound('pickup_fuel');
    } else {
      pl.heal(p.value);
      this._sound('pickup_repair');
    }
    this._particles('pickup', p.x, p.y, 0, 0, 5, 1, p.kind);
  }

  _updatePickups(dt, pl) {
    const g = this.game;
    const world = g.world;
    const magnetR = pl.stats.magnetR + pl.r;
    const collectR = pl.r + PICKUPS.collectR;
    const sleep2 = PICKUPS.sleepDist * PICKUPS.sleepDist;
    const drag = Math.exp(-PICKUPS.drag * dt);
    const bhs = g.hazards ? g.hazards.blackHoles : null;
    for (const p of this.pickups) {
      if (!p.active) continue;
      const dx = pl.x - p.x, dy = pl.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > sleep2) continue;
      p.t += dt;
      p.prevX = p.x; p.prevY = p.y;
      const d = Math.sqrt(d2);
      // burst salvage (crates, satellites, logs, rock fragments) homes in from farther away
      const reach = p.autoMagnet && p.t > PICKUPS.burstMagnetDelay ? Math.max(magnetR, PICKUPS.burstMagnetR) : magnetR;
      if (!pl.dead && !p.magnet && d < reach && (p.t > 0.25 || !p.loose) && this._wants(p.kind)) p.magnet = true;
      if (p.magnet) {
        if (pl.dead || !this._wants(p.kind)) { p.magnet = false; p.loose = true; continue; }
        // homing: fly through walls toward the astronaut
        const k = PICKUPS.magnetAccel * dt / (d || 1);
        p.vx += dx * k; p.vy += dy * k;
        const sp = Math.hypot(p.vx, p.vy), max = PICKUPS.magnetSpeed + pl.speed;
        if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (Math.hypot(pl.x - p.x, pl.y - p.y) < collectR) this._collect(p);
        continue;
      }
      if (!p.loose) continue;
      if (g.hazards) {
        const gv = g.hazards.gravityAt(p.x, p.y, this._g);
        p.vx += gv.ax * dt; p.vy += gv.ay * dt;
      }
      p.vx *= drag; p.vy *= drag;
      moveCircle(p, dt, world, this._res);
      if (bhs) for (const b of bhs) if (Math.hypot(p.x - b.x, p.y - b.y) < b.horizon) p.active = false;
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    const g = this.game, pl = g.player;
    if (!pl) return;
    // dock: deposit carried salvage, refill everything while inside
    const d = this.dock;
    const wasIn = this.inDock;
    this.inDock = !!(d && !pl.dead && pl.x >= d.x0 && pl.x <= d.x1 && pl.y >= d.y0 && pl.y <= d.y1);
    if (this.inDock) {
      if (!wasIn) this._sound('dock');
      if (g.run && g.run.salvage > 0) {
        if (g.deposit) g.deposit();
        else if (g.save) { depositSalvage(g.save, g.run); if (g.persist) g.persist(); }
      }
      pl.refill(dt);
    }
    // key items: taken by touching their pad
    if (!pl.dead) {
      for (const it of this.items) {
        if (it.taken) continue;
        if (Math.hypot(pl.x - it.x, pl.y - it.y) < INTERACT.itemRange + pl.r) this._takeItem(it);
      }
    }
    this._updatePickups(dt, pl);
    this._findInteractable(pl);
  }

  _takeItem(it) {
    const g = this.game, pl = g.player;
    it.taken = true;
    if (g.save) g.save.items[it.key] = true;
    if (it.key === 'explosives') pl.charges = pl.stats.maxCharges;
    this._sound('item');
    this._particles('item', it.x, it.y, 0, 0, 20, 1, it.key);
    if (g.onItem) g.onItem(it.key);
    if (g.persist) g.persist();
  }

  _consider(kind, x, y, range, ref, pl) {
    const d = Math.hypot(pl.x - x, pl.y - y);
    if (d > range || d >= this._best) return;
    this._best = d;
    const o = this._inter;
    o.kind = kind; o.label = LABEL[kind]; o.x = x; o.y = y; o.ref = ref;
    this.interactable = o;
  }

  _findInteractable(pl) {
    this.interactable = null;
    this._best = Infinity;
    if (pl.dead) return;
    const R = INTERACT.range;
    const s = pl.stats;
    for (const d of this.doors) if (!d.open) this._consider('door', d.x, d.y, INTERACT.doorRange, d, pl);
    for (const c of this.crates) if (!c.opened) this._consider('crate', c.x, c.y, R, c, pl);
    for (const t of this.terminals) this._consider('terminal', t.x, t.y, R, t, pl);
    for (const sat of this.satellites) if (!sat.active) this._consider('satellite', sat.x, sat.y, INTERACT.satelliteRange, sat, pl);
    if (pl.o2 < s.o2Max - 0.5 || pl.fuel < s.fuelMax - 0.5) for (const r of this.refills) this._consider('refill', r.x, r.y, R, r, pl);
    if (pl.hasItem('explosives') && pl.charges < s.maxCharges) for (const l of this.lockers) this._consider('locker', l.x, l.y, R, l, pl);
    if (this.workbench) this._consider('workbench', this.workbench.x, this.workbench.y, R, this.workbench, pl);
    if (this.capsule) this._consider('capsule', this.capsule.x, this.capsule.y, R, this.capsule, pl);
  }

  // ------------------------------------------------------------------ interactions

  interact() {
    const it = this.interactable;
    if (!it) return false;
    const g = this.game, pl = g.player, save = g.save;
    const ref = it.ref;
    switch (it.kind) {
      case 'door':
        if (!pl.hasItem('keycard')) {
          this._sound('deny');
          if (g.toast) g.toast("Porte verrouillée : il te faut une carte d'accès.", TOAST_WARN);
          return false;
        }
        for (const i of ref.tiles) g.world.set(i % g.world.w, Math.floor(i / g.world.w), TILE_ID.DOOR_OPEN);
        ref.open = true;
        this._sound('door');
        this._particles('door', ref.x, ref.y, 0, 0, 8, 1, 0);
        break;
      case 'crate':
        ref.opened = true;
        if (save && !save.world.crates.includes(ref.id)) save.world.crates.push(ref.id);
        this.spawnSalvage(ref.x, ref.y, ref.value);
        this._sound('crate');
        this._particles('crate', ref.x, ref.y, 0, 0, 10, 1, 0);
        break;
      case 'terminal': {
        const first = !ref.read;
        ref.read = true;
        if (first && save && !save.world.logs.includes(ref.log)) {
          save.world.logs.push(ref.log);
          save.stats.logsRead = save.world.logs.length;
          this.spawnSalvage(ref.x, ref.y, ECONOMY.logSalvage);
        }
        this._sound('terminal');
        if (g.onLog) g.onLog(ref.log);
        break;
      }
      case 'satellite':
        ref.active = true;
        if (save && !save.world.satellites.includes(ref.id)) save.world.satellites.push(ref.id);
        if (g.reveal) g.reveal(ref.x, ref.y, FOG.satelliteR);
        this.spawnSalvage(ref.x, ref.y, ECONOMY.satelliteSalvage);
        this._sound('satellite');
        this._particles('satellite', ref.x, ref.y, 0, 0, 1, 1, FOG.satelliteR);
        if (g.onSatellite) g.onSatellite(ref.id);
        break;
      case 'refill':
        pl.o2 = pl.stats.o2Max; pl.fuel = pl.stats.fuelMax; pl.fuelEmpty = false;
        this._sound('refill');
        if (g.toast) g.toast('Oxygène et carburant au maximum.', TOAST_INFO);
        return true;
      case 'locker':
        pl.charges = pl.stats.maxCharges;
        this._sound('refill');
        if (g.toast) g.toast('Charges explosives rechargées.', TOAST_INFO);
        return true;
      case 'workbench':
        if (g.setState) g.setState('SHOP');
        return true;
      case 'capsule':
        if (!pl.hasItem('anchor')) {
          this._sound('deny');
          if (g.toast) g.toast("Trop de gravité pour s'arrimer : il te faut l'Ancre gravitationnelle.", TOAST_WARN);
          return false;
        }
        this._sound('capsule');
        if (g.victory) g.victory();
        return true;
      default:
        return false;
    }
    if (g.persist) g.persist();
    return true;
  }

  _sound(name, volume = 1, pitch = 1) {
    const a = this.game.audio;
    if (!a) return;
    const o = this._snd;
    o.volume = volume; o.pitch = pitch; o.material = '';
    a.play(name, o);
  }

  _particles(kind, x, y, vx, vy, count, power, extra) {
    const p = this.game.particles;
    if (!p) return;
    const o = this._fx;
    o.vx = vx; o.vy = vy; o.nx = 0; o.ny = 0; o.count = count; o.power = power;
    o.r = typeof extra === 'number' ? extra : 0;
    o.material = typeof extra === 'string' ? extra : '';
    o.color = '';
    p.spawn(kind, x, y, o);
  }
}

const STATIC = { static: true };
const BURST = { burst: true };
