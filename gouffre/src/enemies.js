// Enemies (DESIGN.md §6) — STUB for step 1.
// The final API is in place so the core engine can call it; behaviours, projectiles
// and drawing are implemented by the next step. See NOTES-core.md.
import { ENEMY_SCALING } from './config.js';

/** Base stats per enemy key (placeholder numbers, tune in step 2). */
export const ENEMY_DEFS = {
  slime: { name: 'Gelée', hp: 18, dmg: 8, speed: 60, w: 12, h: 10, sprite: 'enemy_slime', gold: 2 },
  bat: { name: 'Chauve-souris', hp: 10, dmg: 6, speed: 70, w: 12, h: 10, sprite: 'enemy_bat', gold: 2 },
  skeleton: { name: 'Squelette', hp: 30, dmg: 10, speed: 38, w: 10, h: 24, sprite: 'enemy_skeleton', gold: 5 },
  spider: { name: 'Araignée', hp: 26, dmg: 12, speed: 90, w: 14, h: 10, sprite: 'enemy_spider', gold: 6 },
  ghost: { name: 'Spectre', hp: 24, dmg: 12, speed: 40, w: 14, h: 18, sprite: 'enemy_ghost', gold: 7 },
  imp: { name: 'Diablotin de feu', hp: 34, dmg: 14, speed: 60, w: 12, h: 14, sprite: 'enemy_imp', gold: 10 },
  golem: { name: 'Golem', hp: 90, dmg: 20, speed: 26, w: 22, h: 28, sprite: 'enemy_golem', gold: 16 },
  guardian: { name: "Le Gardien de l'Abysse", hp: 900, dmg: 24, speed: 50, w: 40, h: 48, sprite: 'enemy_guardian', gold: 300 },
};

/** Depth scaling from DESIGN §6: hp × (1 + d/60), dmg × (1 + d/80), × 1.5 in NG+. */
export function scaleStat(base, depth, kind, ngPlus = false) {
  const k = kind === 'hp' ? 1 + depth * ENEMY_SCALING.hpPerM : 1 + depth * ENEMY_SCALING.dmgPerM;
  return base * k * (ngPlus ? ENEMY_SCALING.ngPlusMul : 1);
}

export class EnemyManager {
  constructor(game) {
    this.game = game;
    this.list = [];          // live enemies
    this.projectiles = [];   // enemy projectiles (bones, fireballs)
    this.spawns = [];        // spawn points from worldgen (not yet instantiated)
  }

  /** New run / new world: take the worldgen spawn list. */
  reset(spawns) {
    this.list.length = 0;
    this.projectiles.length = 0;
    this.spawns = spawns ? spawns.slice() : [];
  }

  /** Create an enemy of `key` at (x, y) (anchor semantics as worldgen spawns). TODO step 2. */
  spawn(key, x, y, opts = {}) { return null; }

  /** Per fixed tick. Only enemies within ~1.5 screens of the camera update. TODO step 2. */
  update(dt) {}

  /** Draw live enemies and projectiles (world -> screen with camX/camY). TODO step 2. */
  draw(ctx, camX, camY, alpha) {}

  /** Push dynamic lights (imps, fireballs) into the lighting system. TODO step 2. */
  addLights(lighting) {}

  /**
   * Apply player strike damage to every enemy overlapping `box` ({x,y,w,h} px).
   * @returns {number} number of enemies hit (the caller triggers hit-stop/shake).
   */
  damageInBox(box, dmg, fromX, opts = {}) { return 0; }

  get count() { return this.list.length; }
}
