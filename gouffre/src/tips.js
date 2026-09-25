// First-expedition coaching: contextual tips (shown once each, remembered in the save)
// and the stuck detector behind the pause menu's "Corde de secours".
//
//   const coach = new Coach(game)
//   coach.reset()                    new world / new run (stuck state cleared, pending tips kept)
//   coach.update(dt)                 every fixed tick while PLAYING (after the player moved)
//   coach.onAttach() / onOre() / onBank() / onStrike(dir, result) / onTooHard(locked)   game events
//   coach.show(key)                  force a tip (tests); returns false if already seen / disabled
//   coach.canRescue                  true once the hero has been stuck long enough (pause menu)
//   coach.resetStuck()
//
// Tips are drawn by hud.tip() (a small panel under the top HUD row, one at a time, it waits
// for banners and the banking tally). Text depends on the last input source: touch, keyboard
// or gamepad. save.tips = { key: 1 } marks seen tips; save.settings.tips = false disables them.
import { TILE } from './config.js';
import { TILE_ID } from './tiles.js';

/** Tip texts: [line 1, line 2] per input kind. */
export const TIPS = {
  move: {
    touch: ['Joystick à gauche : marcher et viser', 'Boutons à droite : Saut · Frapper · Grappin'],
    kb: ['← → : marcher · Espace : sauter', 'X : frapper · C : grappin · Échap : pause'],
    pad: ['Stick : marcher · A : sauter', 'X : frapper · B : grappin · Start : pause'],
  },
  dig: {
    touch: ['Joystick vers le bas + Frapper', 'creuse sous tes pieds : ouvre la trappe du puits'],
    kb: ['↓ + X : creuser sous tes pieds', 'La pioche creuse là où tu vises : ← → ↑ ↓'],
    pad: ['Bas + X : creuser sous tes pieds', 'La pioche creuse là où tu vises avec le stick'],
  },
  grapple: {
    touch: ['Grappin : lance le crochet vers le haut', 'Le joystick choisit la direction'],
    kb: ['C : lance le grappin vers le haut', 'Les flèches choisissent la direction'],
    pad: ['B : lance le grappin vers le haut', 'Le stick choisit la direction'],
  },
  climb: {
    touch: ['Accroché ! Joystick en haut : enrouler', 'Grappin encore : se hisser · Saut : lâcher'],
    kb: ['Accroché ! ↑ : enrouler la corde', 'C encore : se hisser · Espace : lâcher'],
    pad: ['Accroché ! Haut : enrouler la corde', 'B encore : se hisser · A : lâcher'],
  },
  bank: {
    all: ['Minerai dans le sac !', 'Remonte au camp pour le mettre à l’abri'],
  },
  forge: {
    touch: ['Butin à l’abri : c’est de l’or banqué', 'Dépense-le chez le forgeron : bouton « Forge »'],
    kb: ['Butin à l’abri : c’est de l’or banqué', 'Dépense-le chez le forgeron : touche E'],
    pad: ['Butin à l’abri : c’est de l’or banqué', 'Dépense-le chez le forgeron : bouton Y'],
  },
  // not remembered: shown again each time the stuck detector fires
  unstuck: {
    touch: ['Pour remonter : Grappin, puis Grappin encore', 'chaque appui te hisse · pousse vers le bord pour sortir'],
    kb: ['Pour remonter : C, puis C encore', 'chaque appui te hisse · pousse vers le bord pour sortir'],
    pad: ['Pour remonter : B, puis B encore', 'chaque appui te hisse · pousse vers le bord pour sortir'],
  },
  rescue: {
    all: ['Vraiment coincé ?', 'Pause → « Corde de secours » : retour au camp'],
  },
};
/** Tips remembered in the save (shown once). */
export const TIP_KEYS = ['move', 'dig', 'grapple', 'climb', 'bank', 'forge'];

/** Stuck detector tuning (seconds / presses / px). */
export const STUCK = {
  hintAfter: 20, hintTries: 4,       // climbing reminder
  rescueAfter: 45, rescueTries: 6,   // "Corde de secours" offered
  climbReset: 40,                    // rising this much above the reference = progress
  dropReset: 64,                     // falling this much lower = a new situation
  sideReset: 6 * TILE,               // moving this far sideways = a new situation
  minDepth: 2,                       // metres below the surface
};

export class Coach {
  constructor(game) {
    this.game = game;
    this.digIdle = 0;       // seconds in the camp since the move tip without digging
    this.forgeDelay = -1;   // countdown to the Forge tip after the first bank
    this.stuck = { active: false, refX: 0, refY: 0, t: 0, tries: 0, hinted: false, stuck: false };
  }

  get enabled() { const s = this.game.save; return !s || !s.settings || s.settings.tips !== false; }

  seen(key) { const s = this.game.save; return !!(s && s.tips && s.tips[key]); }

  /** Which text set to use for the current input device. */
  kind() {
    const inp = this.game.input;
    if (inp.lastSource === 'pad') return 'pad';
    if (inp.touchEnabled) return 'touch';
    return 'kb';
  }

  /** Show a tip now (queued behind the current one). Remembered tips show once. */
  show(key) {
    const def = TIPS[key];
    if (!def || !this.enabled) return false;
    const remember = TIP_KEYS.includes(key);
    if (remember && this.seen(key)) return false;
    const lines = def.all || def[this.kind()] || def.kb;
    const g = this.game;
    if (g.hud && g.hud.tip) g.hud.tip(lines[0], lines[1], { key });
    if (remember && g.save) {
      if (!g.save.tips) g.save.tips = {};
      g.save.tips[key] = 1;
      if (g.persist) g.persist();
    }
    return true;
  }

  /** Remember a tip as seen without showing it (the player already did the thing). */
  markSeen(key) {
    const s = this.game.save;
    if (!s || !TIP_KEYS.includes(key)) return;
    if (!s.tips) s.tips = {};
    s.tips[key] = 1;
  }

  reset() {
    this.digIdle = 0;
    this.forgeDelay = -1;
    this.resetStuck();
  }

  resetStuck() {
    const st = this.stuck;
    st.active = false; st.t = 0; st.tries = 0; st.hinted = false; st.stuck = false;
  }

  /** The hero may use the "Corde de secours" (pause menu). */
  get canRescue() { return this.stuck.stuck; }

  // ---------------------------------------------------------------- events

  onAttach() {
    this._done('grapple'); // found it on their own
    if (!this.seen('climb')) this.show('climb');
  }
  /** The hero dug downward (or opened the trapdoor): the dig tip is not needed any more. */
  onDigDown() { this._done('dig'); }

  _done(key) {
    const g = this.game;
    if (!this.seen(key)) this.markSeen(key);
    if (g.hud && g.hud.cancelTip) g.hud.cancelTip(key);
  }
  onOre() { if (!this.seen('bank')) this.show('bank'); }
  onBank() { if (!this.seen('forge') && this.forgeDelay < 0) this.forgeDelay = 2.4; }

  // ---------------------------------------------------------------- per tick

  update(dt) {
    const g = this.game, p = g.player;
    if (!p || !g.gen) return;
    if (this.enabled) this._tips(dt);
    this._stuck(dt);
  }

  _tips(dt) {
    const g = this.game, p = g.player, camp = g.gen.camp;
    if (p.dead) return;
    const inCamp = p.feetY <= camp.bankY;
    // 1. controls, as soon as the expedition starts (the hud waits for the camp banner)
    if (!this.seen('move')) { this.show('move'); return; }
    // 2. digging: on / next to the trapdoor, or idling in the camp for a while
    if (!this.seen('dig')) {
      const td = camp.trapdoor;
      const nearTrap = td && inCamp && p.cx > td.x0 * TILE - TILE && p.cx < (td.x1 + 1) * TILE + TILE;
      if (inCamp) this.digIdle += dt;
      if (nearTrap || this.digIdle > 9) this.show('dig');
      else if (p.depth >= 3) this.show('dig'); // got down some other way
      return;
    }
    // 3. the grapple, once a few metres down
    if (!this.seen('grapple') && p.depth >= 5 && p.onGround) { this.show('grapple'); return; }
    // 6. the Forge, a moment after the first bank (once the tally is up)
    if (this.forgeDelay >= 0) {
      this.forgeDelay -= dt;
      if (this.forgeDelay <= 0) { this.forgeDelay = -1; this.show('forge'); }
    }
  }

  _stuck(dt) {
    const g = this.game, p = g.player, st = this.stuck;
    const inp = g.input;
    if (p.dead || !g.run || g.run.over || p.depth < STUCK.minDepth || (g.enemies && g.enemies.gatesSealed)) {
      if (st.active) this.resetStuck();
      return;
    }
    const newRef = () => { st.refX = p.cx; st.refY = p.feetY; st.t = 0; st.tries = 0; st.hinted = false; st.stuck = false; };
    if (!st.active) { st.active = true; newRef(); }
    if (p.feetY < st.refY - STUCK.climbReset || p.feetY > st.refY + STUCK.dropReset || Math.abs(p.cx - st.refX) > STUCK.sideReset) newRef();
    st.t += dt;
    if (inp.pressed('jump') || inp.pressed('grapple')) st.tries++;
    if (!st.hinted && st.t >= STUCK.hintAfter && st.tries >= STUCK.hintTries) {
      st.hinted = true;
      this.show('unstuck');
    }
    if (!st.stuck && st.t >= STUCK.rescueAfter && st.tries >= STUCK.rescueTries) {
      st.stuck = true;
      this.show('rescue');
      // even with tips turned off, say once where the way out is
      if (!this.enabled && g.toast) g.toast('Coincé ?', { color: '#ffe6a0', sub: 'Pause → Corde de secours', life: 3 });
    }
  }
}

/** Is the tile the camp trapdoor? */
export function isTrapdoor(id) { return id === TILE_ID.TRAPDOOR; }
