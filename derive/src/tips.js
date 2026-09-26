// Onboarding: contextual tips shown once each (DESIGN.md §10), remembered in save.tips, turned off
// with Réglages → Astuces (save.settings.tips = false).
//
//   const coach = new Coach(game)
//   coach.reset()                 new life (per-life timers cleared; seen tips stay seen)
//   coach.update(dt)              every fixed tick while PLAYING (after the simulation)
//   coach.onDeposit() / onItem(key) / onSatellite() / onTileBroken(tileKey)   game events (main.js)
//   coach.show(key) -> bool       show a tip now (tests); false when already seen or tips are off
//   coach.hide()                  withdraw the tip on screen (tips turned off)
//   TIPS, TIP_KEYS
//
// Tips are drawn by hud.tip(line1, line2, { key }) (one at a time; the HUD queues them). Texts
// depend on the last input device: touch, keyboard or gamepad. A new tip is only offered while no
// other tip is on screen, so they never pile up.
import { BELT, CENTER } from './config.js';

/** Tip texts: [line 1, line 2] per input kind ('all' = any device). */
export const TIPS = {
  move: {
    touch: ['Joystick à gauche : pousse dans cette direction', 'Tu dérives : l’élan te porte sans effort'],
    kb: ['Flèches ou ZQSD / WASD : pousse dans cette direction', 'Tu dérives : l’élan te porte sans effort'],
    pad: ['Stick gauche : pousse dans cette direction', 'Tu dérives : l’élan te porte sans effort'],
  },
  brake: {
    touch: ['Frein : les rétro-fusées t’arrêtent', 'Boost : une impulsion rapide (carburant)'],
    kb: ['Maj ou X : freiner avec les rétro-fusées', 'Espace : boost, une impulsion rapide'],
    pad: ['B : freiner avec les rétro-fusées', 'A : boost, une impulsion rapide'],
  },
  action: {
    touch: ['Le bouton Action apparaît près des éléments utiles', 'Ouvrir, Lire, Activer, Établi…'],
    kb: ['E : interagir avec ce qui est proche', 'Ouvrir, Lire, Activer, Établi…'],
    pad: ['Y : interagir avec ce qui est proche', 'Ouvrir, Lire, Activer, Établi…'],
  },
  salvage: { all: ['Ferraille ramassée !', 'Rapporte-la au dock de l’Albatros pour la mettre à l’abri'] },
  deposit: {
    touch: ['Ferraille déposée : elle est à l’abri', 'Dépense-la à l’Établi, juste à côté du dock'],
    kb: ['Ferraille déposée : elle est à l’abri', 'Dépense-la à l’Établi (touche E), à côté du dock'],
    pad: ['Ferraille déposée : elle est à l’abri', 'Dépense-la à l’Établi (bouton Y), à côté du dock'],
  },
  o2: { all: ['Oxygène bas !', 'Rentre au dock de l’Albatros ou trouve une bonbonne'] },
  fuel: { all: ['Carburant vide : tu dérives', 'Il se recharge seul après 1,5 s sans poussée'] },
  satellite: {
    touch: ['Satellite activé : la carte se dévoile', 'Carte : bouton en haut à droite'],
    kb: ['Satellite activé : la carte se dévoile', 'Carte : touche Tab ou M'],
    pad: ['Satellite activé : la carte se dévoile', 'Carte : bouton Select'],
  },
  belt: { all: ['Ceinture de Charon : des astéroïdes dérivent', 'Un choc trop rapide perce la coque : ralentis'] },
  door: { all: ['Porte verrouillée : il faut une carte d’accès', 'Cherche dans les épaves du secteur'] },
  rubble: { all: ['Un éboulis bouche la galerie', 'Il faudra des explosifs pour le faire sauter'] },
  charge: {
    touch: ['Charge : pose un explosif qui dérive avec toi', 'Éloigne-toi : il saute au bout de 2,5 s'],
    kb: ['C : pose un explosif qui dérive avec toi', 'Éloigne-toi : il saute au bout de 2,5 s'],
    pad: ['X : pose un explosif qui dérive avec toi', 'Éloigne-toi : il saute au bout de 2,5 s'],
  },
  blast: { all: ['Passage dégagé !', 'Les charges se rechargent au dock ou au casier d’Orion'] },
  heat: { all: ['Surchauffe : la chaleur ronge la coque', 'Sans bouclier thermique, fais demi-tour'] },
  flare: { all: ['Éruption ! Le soleil pulse avant de cracher', 'Abrite-toi derrière un rocher ou une coque'] },
  gravity: { all: ['Gravité critique : le trou noir t’aspire', 'Freine et pousse à l’opposé, vite'] },
  storm: { all: ['Tempête ionique : le bord du secteur', 'Elle ronge la coque : reviens vers le centre'] },
};
/** Every tip is shown once (remembered in save.tips). */
export const TIP_KEYS = Object.keys(TIPS);

export class Coach {
  constructor(game) {
    this.game = game;
    this.lastKey = null;
    this.driftT = 0;    // s spent cruising fast (brake tip)
    this.playT = 0;     // s alive this life
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

  show(key) {
    const def = TIPS[key];
    const g = this.game;
    if (!def || !this.enabled || this.seen(key)) return false;
    const lines = def.all || def[this.kind()] || def.kb;
    g.hud.tip(lines[0], lines[1], { key });
    g.audio.play('tip', {});
    this.lastKey = key;
    this.markSeen(key);
    g.persist();
    return true;
  }

  /** Remember a tip as seen without showing it (the player already did the thing). */
  markSeen(key) {
    const s = this.game.save;
    if (!s.tips) s.tips = {};
    s.tips[key] = 1;
  }

  hide() { if (this.lastKey) this.game.hud.cancelTip(this.lastKey); }

  reset() { this.driftT = 0; this.playT = 0; }

  /** Offer a tip only when none is on screen. */
  _offer(key) { return !this.seen(key) && !this.game.hud.tipActive && this.show(key); }

  // ---------------------------------------------------------------- events

  onDeposit() { this.show('deposit'); }
  onSatellite() { this.show('satellite'); }
  onItem(key) { if (key === 'explosives') this.show('charge'); }
  onTileBroken(tileKey) { if (tileKey === 'rubble') this.show('blast'); }

  // ---------------------------------------------------------------- per tick

  update(dt) {
    const g = this.game, p = g.player;
    if (!this.enabled || p.dead) return;
    this.playT += dt;
    if (!this.seen('move')) { if (this.playT > 1.2) this._offer('move'); return; }
    // the player brakes on their own: no need to explain it
    if (p.braking && !this.seen('brake')) { this.markSeen('brake'); g.hud.cancelTip('brake'); }
    this.driftT = p.speed > 90 ? this.driftT + dt : 0;
    if (this.driftT > 2.5 || this.playT > 25) this._offer('brake');
    if (g.run.salvage > 0) this._offer('salvage');
    if (p.o2Low) this._offer('o2');
    if (p.fuelEmpty) this._offer('fuel');
    const h = g.hazards;
    if (h.heatAtPlayer > 0) this._offer('heat');
    if (h.gravCritical) this._offer('gravity');
    if (h.stormIntensity > 0.3) this._offer('storm');
    for (let i = 0; i < h.suns.length; i++) {
      const s = h.suns[i];
      if (s.flareState === 'warn' && Math.hypot(p.x - s.x, p.y - s.y) < s.heatR * 1.4) this._offer('flare');
    }
    const d = Math.hypot(p.x - CENTER, p.y - CENTER);
    if (d > BELT.rInner - 120 && d < BELT.rOuter) this._offer('belt');
    const it = g.entities.interactable;
    if (it) {
      if (it.kind === 'door' && !g.save.items.keycard) this._offer('door');
      else this._offer('action');
    }
    const rb = g.gen.rubble;
    if (!g.save.items.explosives && Math.hypot(p.x - rb.x, p.y - rb.y) < 90) this._offer('rubble');
  }
}
