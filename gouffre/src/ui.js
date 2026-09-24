// DOM overlays styled gothic (DESIGN.md §9): title, pause, forge, death, victory.
// Step 1: title and pause are functional; forge / death / victory are minimal
// placeholders with the final API (step 2 fills them in).
import { drawText, measureText } from './hud.js';

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Crisp pixel-font logo rendered to a canvas and upscaled with CSS. */
function pixelLogo(text, cssScale) {
  const w = measureText(text) + 4, h = 13;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  drawText(g, text, 2, 3, '#e8c878', { outline: '#3a0610' });
  // blood-red lower half tint
  const img = g.getImageData(0, 0, w, h);
  for (let y = 6; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (img.data[i + 3] && img.data[i] > 200) { img.data[i] = 214; img.data[i + 1] = 72 + (h - y) * 8; img.data[i + 2] = 64; }
  }
  g.putImageData(img, 0, 0);
  c.className = 'pixel-logo';
  sizeLogo(c, cssScale);
  return c;
}

function sizeLogo(c, cssScale) {
  c.style.width = c.width * cssScale + 'px';
  c.style.height = c.height * cssScale + 'px';
}

/** Integer CSS scale of the title logo for the current viewport. */
function logoScale() {
  return Math.max(4, Math.min(9, Math.floor(Math.min(window.innerWidth / 70, window.innerHeight / 30))));
}

export class UI {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.current = null;
    this.name = null;
  }

  get open() { return !!this.current; }

  /**
   * Re-fit viewport-dependent overlay parts (called on resize). A home-screen
   * launch boots in portrait, so the title logo must follow the rotation.
   */
  relayout() {
    if (!this.current) return;
    const logo = this.current.querySelector('.pixel-logo');
    if (logo) sizeLogo(logo, logoScale());
  }

  hide() {
    if (this.current) this.current.remove();
    this.current = null;
    this.name = null;
  }

  _show(name, panel) {
    this.hide();
    this.current = panel;
    this.name = name;
    this.root.appendChild(panel);
    const first = panel.querySelector('button');
    if (first && !('ontouchstart' in window)) first.focus({ preventScroll: true });
  }

  _button(label, onClick, cls = '') {
    const b = el('button', 'gbtn ' + cls, label);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      this.game.audio.unlock();
      this.game.audio.play('ui');
      onClick();
    });
    return b;
  }

  showTitle({ onPlay }) {
    const ov = el('div', 'ov ov-title');
    const box = el('div', 'title-box');
    box.appendChild(pixelLogo('GOUFFRE', logoScale()));
    box.appendChild(el('div', 'tagline', 'Creuse. Descends. Remonte vivant.'));
    const play = this._button('Jouer', onPlay, 'primary');
    play.dataset.act = 'play';
    box.appendChild(play);
    const best = this.game.save && this.game.save.stats && this.game.save.stats.bestDepth;
    if (best) box.appendChild(el('div', 'small', `Record : −${best} m`));
    box.appendChild(el('div', 'small keys', 'Clavier : ← → ↑ ↓ · Espace saut · X frapper · C grappin · Échap pause'));
    ov.appendChild(box);
    this._show('title', ov);
  }

  showPause({ onResume, onRestart, onToggleMute }) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel');
    box.appendChild(el('h2', '', 'Pause'));
    box.appendChild(this._button('Reprendre', onResume, 'primary'));
    const mute = this._button(this.game.audio.muted ? 'Son : coupé' : 'Son : activé', () => {
      const m = onToggleMute();
      mute.textContent = m ? 'Son : coupé' : 'Son : activé';
    });
    box.appendChild(mute);
    box.appendChild(this._button('Abandonner la descente', onRestart));
    ov.appendChild(box);
    this._show('pause', ov);
  }

  /** Forge shop. TODO step 2: upgrade list with costs from meta.UPGRADES. */
  showShop({ onClose }) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel');
    box.appendChild(el('h2', '', 'La Forge'));
    box.appendChild(el('p', '', 'Le forgeron attise ses braises… Les améliorations arrivent bientôt.'));
    box.appendChild(this._button('Retour', onClose, 'primary'));
    ov.appendChild(box);
    this._show('shop', ov);
  }

  /** Death screen. TODO step 2: lost bag, banked gold, run stats. */
  showDeath(stats, { onRestart }) {
    const ov = el('div', 'ov ov-dim ov-red');
    const box = el('div', 'panel');
    box.appendChild(el('h2', '', 'Tu as péri'));
    box.appendChild(el('p', '', `Profondeur atteinte : −${stats.depth || 0} m`));
    box.appendChild(this._button('Redescendre', onRestart, 'primary'));
    ov.appendChild(box);
    this._show('death', ov);
  }

  /** Victory screen. TODO step 2: stats + NG+. */
  showVictory(stats, { onContinue }) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel');
    box.appendChild(el('h2', '', 'Victoire'));
    box.appendChild(el('p', '', "Le Gardien de l'Abysse est tombé."));
    box.appendChild(this._button('Continuer', onContinue, 'primary'));
    ov.appendChild(box);
    this._show('victory', ov);
  }
}

export function createUI(game, root) { return new UI(game, root); }
