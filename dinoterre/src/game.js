// Game state and simulation step. DOM-free so it runs headless in unit tests.
import { TILE, DAY, AUTOSAVE, SURVIVAL } from './config.js';
import { TILE_ID } from './tiles.js';
import { generateWorld } from './worldgen.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { Inventory } from './inventory.js';
import { Particles } from './particles.js';
import { Camera } from './camera.js';
import { Combat } from './combat.js';
import { Pack } from './pack.js';
import { Builder } from './building.js';
import { Spawner } from './spawner.js';
import { Carcass, BonePile, Structure } from './entities.js';
import { SPECIES } from './data/species.js';
import { RESOURCES, FOOD_ORDER } from './data/resources.js';
import { BUILDINGS } from './data/buildings.js';
import { overlap, dist2 } from './physics.js';
import { silentAudio } from './audio.js';

export class Game {
  /**
   * opts: { seed, species, audio, input, save (object from save.js), onSave(data), spawnCreatures }
   */
  constructor(opts = {}) {
    const save = opts.save || null;
    this.seed = save ? save.seed : (opts.seed ?? ((Math.random() * 1e9) | 0));
    this.world = generateWorld(this.seed);
    this.input = opts.input || new Input();
    this.audio = opts.audio || silentAudio;
    this.onSave = opts.onSave || null;
    this.onToast = null;
    this.particles = new Particles();
    this.camera = new Camera();
    this.combat = new Combat(this);
    this.pack = new Pack(this);
    this.builder = new Builder(this);
    this.spawner = new Spawner(this);
    this.spawnCreatures = opts.spawnCreatures ?? true;
    this.inventory = new Inventory(save?.inv);
    this.creatures = [];
    this.allies = [];
    this.carcasses = [];
    this.structures = [];
    this.builtTiles = [];
    this.bonePiles = this.world.bonePiles.map((b) => new BonePile(b.tx, b.ty));
    this.time = 0;
    this.clock = DAY.length * 0.22;          // start in the morning
    this.hitStopT = 0;
    this.paused = false;
    this.autosaveT = AUTOSAVE;
    this.respawnPoint = null;
    this.interactTarget = null;
    this.stats = { kills: 0, tamed: 0, built: 0, deaths: 0, hints: {} };
    this.viewW = 400; this.viewH = 190;
    this.lastToast = '';

    const species = SPECIES[save ? save.species : opts.species] || SPECIES.robuste;
    const sp = this.world.spawn;
    this.player = new Player(species, (sp.tx + 0.5) * TILE, (sp.ty + 1) * TILE);
    if (save) this.applySave(save);
    this.camera.follow(this.player, this.viewW, this.viewH, this.world, 0, true);
  }

  // ------------------------------------------------------------------ time of day
  get dayPhase() { return (this.clock % DAY.length) / DAY.length; }
  get nightAmount() {
    const p = this.dayPhase, f = 0.05;
    if (p < DAY.nightStart - f || p > DAY.nightEnd + f) return 0;
    if (p < DAY.nightStart) return (p - (DAY.nightStart - f)) / f;
    if (p > DAY.nightEnd) return 1 - (p - DAY.nightEnd) / f;
    return 1;
  }
  get isNight() { return this.nightAmount > 0.5; }
  get day() { return Math.floor(this.clock / DAY.length) + 1; }

  // ------------------------------------------------------------------ main step
  update(dt) {
    if (this.paused) { this.input.endFrame(); return; }
    this.input.update();
    if (this.hitStopT > 0) { this.hitStopT -= dt; this.input.endFrame(); return; }
    this.time += dt;
    this.clock += dt;

    const p = this.player;
    p.resting = false;
    p.update(dt, this);

    if (this.input.pressed('interact') && p.alive) {
      if (this.builder.active) this.builder.place();
      else this.interactTarget?.run();
    }

    for (const c of this.creatures) c.update(dt, this);
    for (const a of this.allies) a.update(dt, this);
    this.creatures = this.creatures.filter((c) => c.alive);
    for (const c of this.carcasses) c.update(dt, this);
    this.carcasses = this.carcasses.filter((c) => c.alive);
    for (const b of this.bonePiles) b.update(dt);
    for (const s of this.structures) {
      s.update(dt);
      if (!s.def.heal) continue;
      const r2 = (4 * TILE) ** 2;
      if (p.alive && dist2(s, p) < r2) { p.heal(s.def.heal * dt); p.resting = s.def.id === 'tente'; }
      for (const a of this.allies) if (dist2(s, a) < r2) a.hp = Math.min(a.stats.hp, a.hp + s.def.heal * dt);
    }
    if (this.spawnCreatures) this.spawner.update(dt);
    this.particles.update(dt);
    this.camera.follow(p, this.viewW, this.viewH, this.world, dt);
    this.interactTarget = this.findInteraction();
    this.hints();

    this.autosaveT -= dt;
    if (this.autosaveT <= 0) { this.autosaveT = AUTOSAVE; this.save(); }
    this.input.endFrame();
  }

  // ------------------------------------------------------------------ interactions
  findInteraction() {
    const p = this.player;
    if (!p.alive) return null;
    const reach = { x: p.x - 10, y: p.y - 8, w: p.w + 20, h: p.h + 14 };
    let best = null;
    const consider = (entity, it) => {
      if (!it) return;
      const d = dist2(entity, p);
      if (!best || it.priority > best.priority || (it.priority === best.priority && d < best.d)) best = { ...it, entity, d };
    };
    for (const c of this.carcasses) if (overlap(reach, c)) consider(c, c.interaction(this));
    for (const b of this.bonePiles) if (b.ready && overlap(reach, b)) consider(b, b.interaction(this));
    for (const s of this.structures) if (overlap(reach, s)) consider(s, s.interaction(this));
    for (const c of this.creatures) if (c.tamable && overlap(reach, c)) consider(c, this.pack.tameInteraction(c));
    if (!best && p.hunger < SURVIVAL.hungerMax - 5 && FOOD_ORDER.some((id) => this.inventory.count(id) > 0)) {
      best = { label: 'Manger', priority: 0, entity: null, run: () => this.eatBest() };
    }
    return best;
  }

  eatBest() {
    for (const id of FOOD_ORDER) if (this.inventory.count(id) > 0) return this.player.eat(id, this);
    this.toast('Rien à manger. Chasse pour obtenir de la viande !');
    return false;
  }

  /** Add a bundle to the inventory with floating feedback. */
  collect(bundle, x, y, how = 'harvest') {
    let dy = 0;
    for (const [id, n] of Object.entries(bundle)) {
      if (!n) continue;
      this.inventory.add(id, n);
      this.float(`+${n} ${RESOURCES[id].name.split(' ')[0]}`, x, y - dy, how === 'deliver' ? '#9fe8ff' : '#ffffff');
      dy += 7;
    }
    this.audio.play(how === 'deliver' ? 'collect' : 'harvest');
    this.particles.spawn('dust', x, y + 4, { n: 5 });
  }

  restAt(structure) {
    const p = this.player;
    this.respawnPoint = structure;
    p.hp = p.species.hp;
    for (const a of this.allies) a.hp = a.stats.hp;
    let msg = 'Tu te reposes. Partie sauvegardée, tu réapparaîtras ici.';
    if (this.isNight) {
      // sleep until morning
      const len = DAY.length;
      this.clock = Math.ceil(this.clock / len) * len + len * 0.02;
      p.hunger = Math.max(0, p.hunger - 15);
      msg = 'Tu dors jusqu\'au matin. Partie sauvegardée.';
    }
    this.audio.play('rest');
    this.toast(msg);
    this.save();
  }

  // ------------------------------------------------------------------ events
  onCreatureDeath(c, killer) {
    if (c.ally) { this.pack.onAllyDeath(c); return; }
    this.stats.kills++;
    this.carcasses.push(new Carcass(c));
    this.particles.spawn('blood', c.cx, c.cy, { n: 8 });
    this.hintOnce('carcass', 'Carcasse ! Approche-toi et appuie sur Interagir pour récupérer peau, os et viande.');
  }

  onPlayerDeath(cause) {
    const lost = this.inventory.loseShare(SURVIVAL.deathLoss);
    this.stats.deaths++;
    this.audio.play('death');
    const why = { faim: 'de faim', noyade: 'noyé', combat: 'au combat' }[cause] || '';
    const n = Object.values(lost).reduce((s, v) => s + v, 0);
    this.toast(`Tu es mort ${why}…${n ? ` Tu perds ${n} ressource${n > 1 ? 's' : ''}.` : ''}`);
    this.builder.cancel();
  }

  respawn() {
    const p = this.player;
    let x, feet;
    if (this.respawnPoint && this.structures.includes(this.respawnPoint)) {
      x = this.respawnPoint.cx; feet = this.respawnPoint.y + this.respawnPoint.h;
    } else {
      const s = this.world.spawn;
      x = (s.tx + 0.5) * TILE; feet = (s.ty + 1) * TILE;
    }
    p.revive(x, feet);
    for (const a of this.allies) this.pack.teleportNear(a);
    // clear predators camping the respawn
    this.creatures = this.creatures.filter((c) => !c.aggressive || Math.abs(c.cx - x) > 14 * TILE);
    this.camera.follow(p, this.viewW, this.viewH, this.world, 0, true);
  }

  // ------------------------------------------------------------------ world edits
  setBuiltTile(tx, ty, key) {
    this.world.set(tx, ty, TILE_ID[key]);
    this.builtTiles.push({ tx, ty, k: key });
  }

  addStructure(s) {
    this.structures.push(s);
    if (s.def.respawn && !this.respawnPoint) this.respawnPoint = s;
  }

  isSafe(px) {
    for (const s of this.structures) if (s.def.safeRadius && Math.abs(px - s.cx) < s.def.safeRadius * TILE) return true;
    return false;
  }

  loot() { return [...this.carcasses, ...this.bonePiles.filter((b) => b.ready)]; }

  viewTiles() {
    return { x0: Math.floor(this.camera.x / TILE), x1: Math.ceil((this.camera.x + this.viewW) / TILE) };
  }

  // ------------------------------------------------------------------ feedback
  toast(msg) { this.lastToast = msg; this.onToast?.(msg); }
  float(text, x, y, color) { this.particles.float(text, x, y, color); }
  hitStop(t) { this.hitStopT = Math.max(this.hitStopT, t); }

  hintOnce(key, msg) {
    if (this.stats.hints[key]) return;
    this.stats.hints[key] = 1;
    this.toast(msg);
  }

  hints() {
    const p = this.player;
    if (this.time > 1.5) this.hintOnce('move', 'Joystick à gauche pour bouger. Mords les dinosaures hostiles pour récolter peau, os et viande.');
    if (p.hunger < 55) this.hintOnce('hunger', 'Tu as faim ! Mange de la viande (bouton Manger), grillée c\'est encore mieux.');
    if (this.inventory.count('skin') >= 3 && this.inventory.count('bone') >= 3) this.hintOnce('build', 'Tu as de quoi construire : ouvre le menu Construire (marteau). Commence par une Tente.');
    if (this.inventory.count('meat') >= 1) {
      const compy = this.creatures.find((c) => c.tamable && dist2(c, p) < (10 * TILE) ** 2);
      if (compy) this.hintOnce('tame', `Un ${compy.def.name} ! Approche-toi avec de la viande crue et appuie sur Interagir pour l'apprivoiser.`);
    }
    if (p.state === 'climb') this.hintOnce('climb', 'Garde Grimper appuyé pour monter, joystick vers le bas pour descendre, Saut pour te propulser.');
    if (p.inWater) this.hintOnce('swim', 'Dans l\'eau : Nager pour remonter, joystick pour te diriger. Surveille ton souffle !');
  }

  // ------------------------------------------------------------------ save / load
  serialize() {
    const p = this.player;
    return {
      seed: this.seed,
      species: p.species.id,
      player: { x: Math.round(p.x), y: Math.round(p.y), hp: +p.hp.toFixed(1), hunger: +p.hunger.toFixed(1), facing: p.facing },
      inv: this.inventory.toJSON(),
      built: this.builtTiles,
      structures: this.structures.map((s) => s.toJSON()),
      respawn: this.respawnPoint ? this.structures.indexOf(this.respawnPoint) : -1,
      allies: this.pack.toJSON(),
      role: this.pack.role,
      clock: Math.round(this.clock),
      stats: this.stats,
    };
  }

  save() {
    if (!this.player.alive) return null;
    const data = this.serialize();
    this.onSave?.(data);
    return data;
  }

  applySave(s) {
    for (const t of s.built || []) if (TILE_ID[t.k] !== undefined) this.setBuiltTile(t.tx, t.ty, t.k);
    for (const st of s.structures || []) if (BUILDINGS[st.id]) this.structures.push(new Structure(BUILDINGS[st.id], st.tx, st.ty));
    this.respawnPoint = this.structures[s.respawn] || null;
    const p = this.player;
    if (s.player) {
      p.x = s.player.x; p.y = s.player.y;
      p.hp = Math.max(1, s.player.hp); p.hunger = s.player.hunger; p.facing = s.player.facing || 1;
      p.clampTo(this.world);
    }
    this.clock = s.clock ?? this.clock;
    this.pack.role = s.role || 'hunt';
    this.stats = { ...this.stats, ...(s.stats || {}), hints: { ...(s.stats?.hints || {}) } };
    this.pack.restore(s.allies || [], p);
  }
}
