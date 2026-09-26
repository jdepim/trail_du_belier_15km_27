// DOM overlays in the "ship console" style (DESIGN.md §10; styles live in index.html).
//
//   showTitle({ resume, touch, installHint, onPlay, onSettings })
//   showSettings({ storage, onToggleMute, onToggleAssist, onToggleShake, onToggleTips, onExport,
//                  onImport, onErase, onBack })
//   showControls(onBack)          touch / keyboard / gamepad reference
//   showTransfer({ onExport, onImport, onBack })
//   showPause({ onResume, onMap, onLogs, onControls, onSettings, onRecall })
//   showMap({ onClose })          close button over the canvas map (render.js draws the map)
//   showShop({ onBuy(key) -> meta.buyUpgrade result, onClose })   the Établi
//   showLog(key, { onClose })     terminal with a typewriter reveal (a tap completes it)
//   showLogs({ onOpen(key), onBack })   logs found so far (x / 9)
//   showDeath(summary, { onRespawn })   summary = meta.settleDeath()
//   showVictory(info, { onContinue, onTitle })   re-entry cinematic, then info = meta.recordVictory()
//   update(dt)                    typewriter + cinematic (main.js calls it every frame outside PLAYING)
//   hide(), relayout(), refresh(), notice(text, life), move(dx, dy), activate(), back(), open, name
//
// Keyboard: arrows / WASD move the focus spatially between buttons, Entrée / Espace press the
// focused one (or the panel's default), Échap / P go back (E also closes the Établi, Tab / M the
// map). Captured at window level before input.js while an overlay is open, so a menu key never
// leaks into the game. Gamepad / injected presses reach move / activate / back through main.js.
// Touch: a button presses on pointerup of the finger that went down on it, so menus answer while
// another finger rests on the screen (the stick thumb); the click that follows is ignored.
// Destructive confirmations (Balise de rappel, Effacer) sit after "Annuler", stay disabled for
// CONFIRM_ARM ms and are pushed away from the finger that opened them: a double tap never confirms.
import { drawText, measureText } from './hud.js';
import { makeIcon, getSprite, celestial } from './sprites.js';
import { UPGRADES, UPGRADE_KEYS, upgradeCost, ITEMS, ITEM_KEYS, LOGS, LOG_KEYS } from './meta.js';
import { mulberry32 } from './rng.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const fmtN = (n) => Math.round(n || 0).toLocaleString('fr-FR');
const metres = (px) => `${fmtN((px || 0) / 8)} m`;
function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min ${String(sec).padStart(2, '0')} s`;
}

/** Pixel-art icon from sprites.makeIcon (a data URL) as an <img>. */
function icon(name, px, cls = 'pix') {
  const url = makeIcon(name, px);
  if (!url) return el('span', cls);
  const img = el('img', cls);
  img.src = url; img.width = px; img.height = px; img.alt = ''; img.draggable = false;
  return img;
}

/** Crisp bitmap-font logo on a small canvas, upscaled by CSS (cyan top, white bottom). */
function pixelLogo(text, cssScale, top = '#7fe6ff', bottom = '#ffffff', outline = '#06122a') {
  const w = measureText(text) + 4, h = 13;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  drawText(g, text, 2, 3, bottom, { outline });
  const img = g.getImageData(0, 0, w, h);
  const tr = parseInt(top.slice(1, 3), 16), tg = parseInt(top.slice(3, 5), 16), tb = parseInt(top.slice(5, 7), 16);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (img.data[i + 3] && img.data[i] > 200) { img.data[i] = tr; img.data[i + 1] = tg; img.data[i + 2] = tb; }
    }
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
  return Math.max(4, Math.min(10, Math.floor(Math.min(window.innerWidth / 60, window.innerHeight / 28))));
}

const NAV = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
const OK_KEYS = { Enter: 1, NumpadEnter: 1, Space: 1 };
const BACK_KEYS = { Escape: 1, KeyP: 1 };
const CONFIRM_ARM = 550;   // ms a destructive confirm button stays disabled after it appears
const CLICK_GUARD = 700;   // ms after a touch press during which the synthetic click is ignored
const TYPE_SPEED = 70;     // characters per second of the log typewriter
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const touchFirst = () => 'ontouchstart' in window;

export class UI {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.current = null;
    this.name = null;
    this.noticeEl = null;
    this.touchPressT = -1e9;
    this.pressPt = { x: 0, y: 0, ok: false };
    this.typer = null;     // { el, text, shown, done, onDone }
    this.cine = null;      // ReentryCinematic while the victory overlay plays it
    window.addEventListener('keydown', (e) => this._onKey(e), true);
  }

  get open() { return !!this.current; }

  /** Re-fit viewport-dependent parts (title logo, cinematic canvas) after a resize / rotation. */
  relayout() {
    if (!this.current) return;
    const logo = this.current.querySelector('.pixel-logo.title');
    if (logo) sizeLogo(logo, logoScale());
    if (this.cine) this.cine.resize(this.game.view.w, this.game.view.h);
  }

  hide() {
    if (this.current) this.current.remove();
    this.current = null;
    this.name = null;
    this.typer = null;
    this.cine = null;
  }

  /** Re-render the live parts of the current overlay (salvage changed by a debug call…). */
  refresh() { if (this.current && this.current._refresh) this.current._refresh(); }

  /** Transient message over everything (corrupted save, storage blocked…). */
  notice(text, life = 5) {
    if (this.noticeEl) this.noticeEl.remove();
    const n = el('div', 'ui-notice', text);
    this.root.appendChild(n);
    this.noticeEl = n;
    setTimeout(() => { if (this.noticeEl === n) { n.remove(); this.noticeEl = null; } }, life * 1000);
  }

  _show(name, panel, { onBack = null, focus = true } = {}) {
    this.hide();
    this.current = panel;
    this.name = name;
    panel._onBack = onBack;
    panel.dataset.ui = name;
    this.root.appendChild(panel);
    if (focus && !touchFirst()) {
      const first = panel.querySelector('.btn.primary:not(:disabled)') || panel.querySelector('button:not(:disabled)');
      if (first) first.focus({ preventScroll: true });
    }
  }

  _button(label, onClick, cls = '', act = null, sub = null) {
    const b = el('button', 'btn ' + cls);
    b.type = 'button';
    b.appendChild(el('span', 'lbl', label));
    if (sub) b.appendChild(el('span', 'sub', sub));
    if (act) b.dataset.act = act;
    this._bindPress(b, () => {
      this.game.audio.unlock();
      this.game.audio.play('ui', {});
      onClick(b);
    });
    return b;
  }

  _setLabel(b, text) { b.querySelector('.lbl').textContent = text; }

  /**
   * Touch / pen: the finger that went down on the button presses it on pointerup (browsers only
   * turn single-finger taps into clicks, so click-only buttons die while a thumb rests on the
   * stick); sliding off cancels. Mouse / keyboard / activate(): the click. The click a touch
   * produces afterwards is ignored, even if the panel was rebuilt under the finger.
   */
  _bindPress(b, fire) {
    let pid = null;
    b.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') pid = e.pointerId; });
    b.addEventListener('pointercancel', (e) => { if (e.pointerId === pid) pid = null; });
    b.addEventListener('pointerup', (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      const r = b.getBoundingClientRect();
      if (e.clientX < r.left - 6 || e.clientX > r.right + 6 || e.clientY < r.top - 6 || e.clientY > r.bottom + 6) return;
      if (b.disabled || !b.isConnected) return;
      this.touchPressT = now();
      this._notePress(e.clientX, e.clientY, true);
      fire(e);
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (b.disabled || now() - this.touchPressT < CLICK_GUARD) return;
      this._notePress(e.clientX, e.clientY, e.detail > 0); // detail 0: keyboard / activate()
      fire(e);
    });
  }

  _notePress(x, y, ok) { this.pressPt.x = x; this.pressPt.y = y; this.pressPt.ok = ok; }

  /** Push a destructive confirm button down until it clears the finger that opened it. */
  _keepClear(b) {
    const pt = this.pressPt;
    if (!pt.ok || !b.isConnected) return;
    for (let i = 0; i < 4; i++) {
      const r = b.getBoundingClientRect();
      const pad = 16;
      if (pt.x < r.left - pad || pt.x > r.right + pad || pt.y < r.top - pad || pt.y > r.bottom + pad) return;
      const need = pt.y + pad - r.top + 2;
      b.style.marginTop = (parseFloat(b.style.marginTop) || 0) + need * 2 + 'px';
    }
  }

  /** Destructive confirm button: disabled for a moment so a double tap cannot reach it. */
  _arm(b) {
    b.disabled = true;
    b.classList.add('arming');
    setTimeout(() => { b.disabled = false; b.classList.remove('arming'); }, CONFIRM_ARM);
    return b;
  }

  /** Two-step confirmation panel inside `box`: "Annuler" first, the armed red button after. */
  _confirm(box, title, text, label, act, onConfirm, onCancel) {
    box.replaceChildren();
    box.appendChild(el('h2', 'red', title));
    box.appendChild(el('p', '', text));
    const row = el('div', 'row confirm');
    row.appendChild(this._button('Annuler', onCancel, 'primary', 'cancel'));
    row.appendChild(this._arm(this._button(label, onConfirm, 'danger', act)));
    box.appendChild(row);
    this._keepClear(row.lastChild);
    this.current._onBack = onCancel;
    if (!touchFirst()) row.firstChild.focus();
  }

  // ---------------------------------------------------------------- keyboard / pad

  _buttons() {
    if (!this.current) return [];
    return [...this.current.querySelectorAll('button:not(:disabled)')].filter((b) => b.offsetParent !== null);
  }

  _onKey(e) {
    if (!this.current) return;
    const tag = e.target && e.target.tagName;
    if ((tag === 'TEXTAREA' || tag === 'INPUT') && e.code !== 'Escape') return;
    const k = e.code;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (NAV[k]) { stop(); this.move(NAV[k][0], NAV[k][1]); return; }
    if (OK_KEYS[k]) { stop(); if (!e.repeat) this.activate(); return; }
    const mapKey = this.name === 'map' && (k === 'Tab' || k === 'KeyM' || (typeof e.key === 'string' && e.key.toLowerCase() === 'm'));
    if (BACK_KEYS[k] || mapKey || (k === 'KeyE' && this.name === 'shop')) { stop(); if (!e.repeat) this.back(); return; }
    if (k === 'Tab') stop(); // never let Tab move the browser focus out of the game
  }

  /**
   * Move the focus to the nearest button in direction (dx, dy): the smallest gap along the
   * direction, with buttons in line (overlapping across it) strongly preferred; wraps around.
   */
  move(dx, dy) {
    const list = this._buttons();
    if (!list.length) return;
    const cur = list.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { this._default().focus({ preventScroll: false }); return; }
    const a = cur.getBoundingClientRect();
    const acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    let best = null, bestS = Infinity, far = null, farS = -Infinity;
    for (const b of list) {
      if (b === cur) continue;
      const r = b.getBoundingClientRect();
      const gap = dy > 0 ? r.top - a.bottom : dy < 0 ? a.top - r.bottom : dx > 0 ? r.left - a.right : a.left - r.right;
      const across = dy ? Math.max(0, Math.max(r.left, a.left) - Math.min(r.right, a.right)) : Math.max(0, Math.max(r.top, a.top) - Math.min(r.bottom, a.bottom));
      const off = dy ? Math.abs(r.left + r.width / 2 - acx) : Math.abs(r.top + r.height / 2 - acy);
      if (gap > -4) {
        const score = gap + across * 3 + off * 0.01 + (dy ? r.left : r.top) * 1e-4; // ties: left / top first
        if (score < bestS) { bestS = score; best = b; }
      } else if (-gap - across * 3 - off * 0.01 > farS) { farS = -gap - across * 3 - off * 0.01; far = b; }
    }
    const next = best || far;
    if (next) { next.focus({ preventScroll: false }); next.scrollIntoView({ block: 'nearest' }); }
  }

  _default() {
    const list = this._buttons();
    return (this.current && this.current.querySelector('.btn.primary:not(:disabled)')) || list[0];
  }

  /** Press the focused button, or the panel's default one. */
  activate() {
    if (!this.current) return;
    const f = document.activeElement;
    const b = f && this.current.contains(f) && f.tagName === 'BUTTON' && !f.disabled ? f : this._default();
    if (b) b.click();
  }

  /** Échap / P / pad B: the panel's back action (resume, close, return). */
  back() {
    if (!this.current || !this.current._onBack) return;
    this.game.audio.play('ui_back', {});
    this.current._onBack();
  }

  // ---------------------------------------------------------------- per frame

  update(dt) {
    const t = this.typer;
    if (t && !t.done) {
      t.shown = Math.min(t.text.length, t.shown + dt * TYPE_SPEED);
      t.el.textContent = t.text.slice(0, Math.floor(t.shown));
      if (t.shown >= t.text.length) this._finishTyping();
    }
    if (this.cine) {
      this.cine.update(dt);
      if (this.cine.done && this.cine.onDone) { const f = this.cine.onDone; this.cine.onDone = null; f(); }
    }
  }

  _finishTyping() {
    const t = this.typer;
    if (!t || t.done) return;
    t.done = true;
    t.shown = t.text.length;
    t.el.textContent = t.text;
    t.el.classList.add('done');
    if (t.onDone) t.onDone();
  }

  // ---------------------------------------------------------------- title

  showTitle({ resume = false, touch = false, installHint = false, onPlay, onSettings }) {
    const save = this.game.save, st = save.stats;
    const owned = ITEM_KEYS.filter((k) => save.items[k]).length;
    const progress = st.deaths > 0 || save.salvage > 0 || owned > 0 || st.victories > 0 || st.time > 60;
    const ov = el('div', 'ov ov-title');
    const box = el('div', 'title-box');
    const logo = pixelLogo('DÉRIVE', logoScale());
    logo.classList.add('title');
    box.appendChild(logo);
    box.appendChild(el('div', 'tagline', 'Perdu dans le vide. Rentre sur Terre.'));
    let label = 'Jouer', sub = null;
    if (resume) { label = 'Continuer'; sub = 'Reprendre la sortie en cours'; }
    else if (progress) { label = 'Continuer'; sub = `Ferraille ${fmtN(save.salvage)} · Équipement ${owned}/${ITEM_KEYS.length}`; }
    box.appendChild(this._button(label, onPlay, 'primary', 'play', sub));
    box.appendChild(this._button('Réglages', onSettings, 'minor', 'settings'));
    if (progress) {
      const bits = [`Morts : ${st.deaths}`, `Journaux : ${save.world.logs.length}/${LOG_KEYS.length}`, `Temps : ${fmtTime(st.time)}`];
      if (st.victories) bits.push(`Retours sur Terre : ${st.victories}`);
      box.appendChild(el('div', 'small', bits.join(' · ')));
    }
    if (touch) box.appendChild(el('div', 'small keys-touch', 'Joystick à gauche : pousser · à droite : Frein, Boost, Action'));
    else box.appendChild(el('div', 'small keys', 'Flèches / ZQSD : pousser · Maj frein · Espace boost · E action · Tab carte · Échap pause'));
    if (installHint) box.appendChild(el('div', 'small install', 'Safari : Partager → « Sur l’écran d’accueil » pour jouer en plein écran et garder ta progression'));
    ov.appendChild(box);
    this._show('title', ov);
  }

  // ---------------------------------------------------------------- settings / controls / transfer

  showSettings(opts) {
    const { storage = true, onToggleMute, onToggleAssist, onToggleShake, onToggleTips, onExport, onImport, onErase, onBack } = opts;
    const game = this.game;
    const reopen = () => this.showSettings(opts);
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel settings');
    const head = el('div', 'panel-head');
    head.appendChild(el('h2', '', 'Réglages'));
    head.appendChild(this._button('Retour', onBack, 'primary close', 'back'));
    box.appendChild(head);
    const se = () => game.save.settings;
    const labels = {
      mute: () => (game.audio.muted ? 'Son : coupé' : 'Son : activé'),
      assist: () => (se().assist !== false ? 'Assistance inertielle : oui' : 'Assistance inertielle : non'),
      shake: () => (se().shake !== false ? 'Secousses : oui' : 'Secousses : non'),
      tips: () => (se().tips !== false ? 'Astuces : oui' : 'Astuces : non'),
    };
    const toggles = { mute: onToggleMute, assist: onToggleAssist, shake: onToggleShake, tips: onToggleTips };
    const grid = el('div', 'set-grid');
    const btns = {};
    for (const k of Object.keys(labels)) {
      btns[k] = this._button(labels[k](), () => { toggles[k](); this._setLabel(btns[k], labels[k]()); }, '', k);
      grid.appendChild(btns[k]);
    }
    grid.appendChild(this._button('Commandes', () => this.showControls(reopen), '', 'controls'));
    grid.appendChild(this._button('Transférer', () => this.showTransfer({ onExport, onImport, onBack: reopen }), '', 'transfer'));
    const erase = this._button('Effacer la sauvegarde', () => this._confirm(box, 'Tout effacer ?',
      'Équipement, ferraille, améliorations, carte, journaux et statistiques seront perdus à jamais.',
      'Effacer définitivement', 'erase-confirm', onErase, reopen), 'danger wide', 'erase');
    grid.appendChild(erase);
    box.appendChild(grid);
    box.appendChild(el('p', 'small hint', 'Assistance inertielle : sans poussée, tu ralentis doucement jusqu’à l’arrêt. Sans elle, tu dérives comme dans le vrai vide.'));
    if (!storage) box.appendChild(el('p', 'notice', 'Stockage indisponible (navigation privée ?) : la progression ne sera pas conservée.'));
    ov.appendChild(box);
    ov._refresh = () => { for (const k of Object.keys(btns)) this._setLabel(btns[k], labels[k]()); };
    this._show('settings', ov, { onBack });
  }

  /** "Commandes": every control for touch, keyboard and gamepad. */
  showControls(onBack) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel wide controls');
    const head = el('div', 'panel-head');
    head.appendChild(el('h2', '', 'Commandes'));
    head.appendChild(this._button('Retour', onBack, 'primary close', 'back'));
    box.appendChild(head);
    const groups = [
      ['Tactile', [
        ['Joystick (moitié gauche)', 'pousser dans une direction, plus ou moins fort'],
        ['Frein', 'rétro-fusées : t’arrête'], ['Boost', 'impulsion rapide'],
        ['Charge', 'pose un explosif (avec les Explosifs)'], ['Action', 'Ouvrir, Lire, Activer, Établi…'],
        ['Carte · Pause', 'en haut à droite'],
      ]],
      ['Clavier', [
        ['Flèches · ZQSD / WASD', 'pousser'], ['Maj · X', 'frein'], ['Espace', 'boost'], ['E', 'action'],
        ['C', 'charge'], ['Tab · M', 'carte'], ['Échap · P', 'pause'],
      ]],
      ['Manette', [
        ['Stick · croix', 'pousser'], ['A', 'boost'], ['B · LT', 'frein'], ['X', 'charge'], ['Y', 'action'],
        ['Select', 'carte'], ['Start', 'pause'],
      ]],
    ];
    if (!touchFirst()) groups.push(groups.shift()); // desktop: keyboard first
    const grid = el('div', 'ctl-grid');
    for (const [title, rows] of groups) {
      const col = el('div', 'ctl-col');
      col.appendChild(el('h3', '', title));
      for (const [k, v] of rows) {
        const r = el('div', 'ctl-row');
        r.appendChild(el('span', 'ck', k));
        r.appendChild(document.createTextNode(' '));
        r.appendChild(el('span', 'cv', v));
        col.appendChild(r);
      }
      grid.appendChild(col);
    }
    box.appendChild(grid);
    box.appendChild(el('p', 'small', 'Dépose ta ferraille au dock de l’Albatros, puis améliore ta combinaison à l’Établi.'));
    ov.appendChild(box);
    this._show('controls', ov, { onBack });
  }

  /** Safari tabs and the home-screen app keep separate storage: the save travels as a text code. */
  showTransfer({ onExport, onImport, onBack }) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel wide transfer');
    box.appendChild(el('h2', '', 'Transférer'));
    box.appendChild(el('p', 'small', 'Safari et l’app de l’écran d’accueil ne partagent pas leur sauvegarde. Copie ce code ici, puis colle-le de l’autre côté.'));
    const out = el('textarea', 'code');
    out.readOnly = true;
    out.rows = 2;
    out.value = onExport();
    out.setAttribute('aria-label', 'Code de ta sauvegarde');
    box.appendChild(out);
    const msg = el('p', 'msg');
    box.appendChild(this._button('Copier le code', () => {
      out.focus(); out.select(); out.setSelectionRange(0, out.value.length); // iOS needs the explicit range
      let ok = false;
      try { ok = document.execCommand && document.execCommand('copy'); } catch { ok = false; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(out.value).then(() => { msg.textContent = 'Code copié.'; }, () => { if (!ok) msg.textContent = 'Sélectionne le code et copie-le.'; });
      }
      if (ok) msg.textContent = 'Code copié.';
    }, '', 'copy'));
    const inp = el('textarea', 'code');
    inp.rows = 2;
    inp.placeholder = 'Colle ici un code DERIVE1:…';
    inp.setAttribute('aria-label', 'Code à importer');
    box.appendChild(inp);
    let confirmStep = false;
    inp.addEventListener('input', () => { confirmStep = false; }); // a new code asks again
    const row = el('div', 'row');
    row.appendChild(this._button('Importer', () => {
      const code = inp.value.trim();
      if (!code) { msg.textContent = 'Colle d’abord un code.'; return; }
      if (!code.replace(/\s+/g, '').startsWith('DERIVE1:')) { msg.textContent = 'Code invalide.'; confirmStep = false; return; }
      if (!confirmStep) {
        confirmStep = true;
        msg.textContent = 'Importer remplace ta progression actuelle. Appuie encore sur « Importer » pour confirmer.';
        return;
      }
      confirmStep = false;
      if (!onImport(code)) msg.textContent = 'Code invalide.';
    }, 'danger', 'import'));
    row.appendChild(this._button('Retour', onBack, 'primary', 'back'));
    box.appendChild(row);
    box.appendChild(msg);
    ov.appendChild(box);
    this._show('transfer', ov, { onBack, focus: false });
  }

  // ---------------------------------------------------------------- pause & map

  showPause(args) {
    const { onResume, onMap, onLogs, onControls, onSettings, onRecall } = args;
    const game = this.game;
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel pause');
    const build = () => {
      box.replaceChildren();
      box.appendChild(el('h2', '', 'Pause'));
      const p = game.player, run = game.run, save = game.save;
      const status = el('div', 'status');
      const chip = (ic, text, cls = '') => { const c = el('span', 'chip ' + cls); c.appendChild(icon(ic, 12)); c.appendChild(document.createTextNode(text)); status.appendChild(c); };
      chip('salvage', `Ferraille : ${fmtN(run.salvage)} transportée · ${fmtN(save.salvage)} déposée`);
      chip('o2', `${Math.ceil(p.o2)} s`);
      for (const k of ITEM_KEYS) if (save.items[k]) { const c = el('span', 'chip item'); c.title = ITEMS[k].name; c.appendChild(icon(k, 14)); status.appendChild(c); }
      box.appendChild(status);
      box.appendChild(this._button('Reprendre', onResume, 'primary', 'resume'));
      const grid = el('div', 'set-grid');
      grid.appendChild(this._button('Carte', onMap, '', 'map'));
      grid.appendChild(this._button('Journaux', onLogs, '', 'logs', `${save.world.logs.length}/${LOG_KEYS.length}`));
      grid.appendChild(this._button('Commandes', onControls, '', 'controls'));
      grid.appendChild(this._button('Réglages', onSettings, '', 'settings'));
      box.appendChild(grid);
      box.appendChild(this._button('Balise de rappel', confirmRecall, 'minor danger', 'recall', 'Retour à l’Albatros'));
      if (this.current === ov) this.current._onBack = onResume;
    };
    const confirmRecall = () => {
      const lost = Math.floor(game.run.salvage || 0);
      const text = lost > 0
        ? `Tu reviens à l’épave de l’Albatros. Ta ferraille transportée (${fmtN(lost)}) sera perdue ; ton équipement est conservé.`
        : 'Tu reviens à l’épave de l’Albatros. Ton équipement et ta ferraille déposée sont conservés.';
      this._confirm(box, 'Balise de rappel ?', text, 'Activer la balise', 'recall-confirm', onRecall, () => {
        build();
        if (!touchFirst()) box.querySelector('button').focus();
      });
    };
    build();
    ov.appendChild(box);
    this._show('pause', ov, { onBack: onResume });
  }

  showMap({ onClose }) {
    const ov = el('div', 'ov ov-map');
    const bar = el('div', 'map-bar');
    bar.appendChild(this._button('Fermer', onClose, 'primary close', 'close'));
    ov.appendChild(bar);
    if (!touchFirst()) ov.appendChild(el('div', 'small map-keys', 'Tab / M / Échap : fermer la carte'));
    this._show('map', ov, { onBack: onClose, focus: false });
  }

  // ---------------------------------------------------------------- the Établi

  showShop({ onBuy, onClose }) {
    const game = this.game;
    const ov = el('div', 'ov ov-shop');
    const wrap = el('div', 'shop');
    const head = el('div', 'shop-head');
    const title = el('div', 'shop-title');
    title.appendChild(icon('action', 22));
    title.appendChild(el('h2', '', 'Établi'));
    head.appendChild(title);
    const pill = el('div', 'salv-pill');
    pill.appendChild(icon('salvage', 16));
    const salvTxt = el('span', 'salv-val', fmtN(game.save.salvage));
    pill.appendChild(salvTxt);
    pill.title = 'Ferraille déposée';
    head.appendChild(pill);
    const close = this._button('Retour', onClose, 'close', 'close');
    head.appendChild(close);
    wrap.appendChild(head);
    const grid = el('div', 'shop-grid');
    wrap.appendChild(grid);
    const foot = el('div', 'shop-foot', 'Seule la ferraille déposée au dock compte. Les améliorations sont permanentes.');
    wrap.appendChild(foot);
    ov.appendChild(wrap);

    const cards = {};
    const renderCard = (k) => {
      const u = UPGRADES[k];
      const lv = game.save.upgrades[k] || 0;
      const cost = upgradeCost(k, lv);
      let c = cards[k];
      if (!c) {
        c = cards[k] = el('div', 'card');
        c.dataset.up = k;
        const ic = el('div', 'ic');
        ic.appendChild(icon(`upg_${k}`, 26));
        const pips = el('span', 'pips');
        for (let i = 0; i < u.max; i++) pips.appendChild(el('i', 'pip'));
        ic.appendChild(pips);
        c.appendChild(ic);
        const mid = el('div', 'mid');
        mid.appendChild(el('div', 'nm', u.name));
        mid.appendChild(el('div', 'ds', u.desc));
        mid.appendChild(el('div', 'fx'));
        c.appendChild(mid);
        const buy = el('button', 'buy');
        buy.type = 'button';
        buy.dataset.buy = k;
        this._bindPress(buy, () => {
          game.audio.unlock();
          const r = onBuy(k);
          if (r.ok) {
            renderAll();
            c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
            const pipsEl = c.querySelectorAll('.pip');
            if (pipsEl[r.level - 1]) pipsEl[r.level - 1].classList.add('new');
            foot.textContent = `${u.name} : niveau ${r.level} ! ${u.effect(r.level)}`;
            foot.classList.add('ok');
            const fl = el('span', 'spent', `−${fmtN(r.cost)}`);
            pill.appendChild(fl);
            setTimeout(() => fl.remove(), 900);
            if (!touchFirst() && c.querySelector('.buy').disabled) {
              const nb = this._buttons().find((x) => x.classList.contains('buy'));
              (nb || close).focus();
            }
          } else {
            foot.textContent = r.reason === 'max' ? `${u.name} : déjà au maximum.` : `Il te manque ${fmtN(r.cost - game.save.salvage)} ferraille.`;
            foot.classList.remove('ok');
          }
        });
        c.appendChild(buy);
        grid.appendChild(c);
      }
      c.style.display = u.requires && !game.save.items[u.requires] ? 'none' : '';
      c.classList.toggle('maxed', cost === Infinity);
      c.querySelectorAll('.pip').forEach((p, i) => p.classList.toggle('on', i < lv));
      const fx = c.querySelector('.fx');
      const buy = c.querySelector('.buy');
      buy.replaceChildren();
      if (cost === Infinity) {
        fx.textContent = `${u.effect(lv)} · maximum`;
        buy.disabled = true;
        buy.appendChild(el('span', 'b1', 'MAX'));
      } else {
        fx.textContent = `${u.effect(lv)} → ${u.effect(lv + 1)}`;
        const afford = game.save.salvage >= cost;
        buy.disabled = !afford;
        const b1 = el('span', 'b1');
        b1.appendChild(icon('salvage', 12));
        b1.appendChild(document.createTextNode(fmtN(cost)));
        buy.appendChild(b1);
        buy.appendChild(el('span', 'b2', afford ? 'Améliorer' : 'Trop cher'));
      }
    };
    const renderAll = () => {
      salvTxt.textContent = fmtN(game.save.salvage);
      for (const k of UPGRADE_KEYS) renderCard(k);
    };
    renderAll();
    ov._refresh = renderAll;
    this._show('shop', ov, { onBack: onClose, focus: false });
    if (!touchFirst()) (this._buttons().find((x) => x.classList.contains('buy')) || close).focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- logs

  showLog(key, { onClose }) {
    const log = LOGS[key];
    const ov = el('div', 'ov ov-dim ov-log');
    const box = el('div', 'panel wide terminal');
    const head = el('div', 'term-head');
    head.appendChild(el('span', 'term-tag', `JOURNAL ${LOG_KEYS.indexOf(key) + 1}/${LOG_KEYS.length}`));
    head.appendChild(el('span', 'term-title', log.title));
    box.appendChild(head);
    const text = el('div', 'term-text');
    text.setAttribute('aria-live', 'polite');
    box.appendChild(text);
    const row = el('div', 'row');
    const btn = this._button('Passer', () => {
      if (this.typer && !this.typer.done) this._finishTyping();
      else onClose();
    }, 'primary', 'log-next');
    row.appendChild(btn);
    box.appendChild(row);
    ov.appendChild(box);
    this._show('log', ov, { onBack: onClose });
    // a tap on the text completes it at once
    text.addEventListener('pointerup', () => this._finishTyping());
    this.typer = { el: text, text: log.text, shown: 0, done: false, onDone: () => { this._setLabel(btn, 'Fermer'); btn.dataset.act = 'close'; } };
  }

  showLogs({ onOpen, onBack }) {
    const save = this.game.save;
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel wide logs');
    const head = el('div', 'panel-head');
    head.appendChild(el('h2', '', `Journaux ${save.world.logs.length}/${LOG_KEYS.length}`));
    head.appendChild(this._button('Retour', onBack, 'primary close', 'back'));
    box.appendChild(head);
    const list = el('div', 'logs-list');
    for (const k of LOG_KEYS) {
      const read = save.world.logs.includes(k);
      const b = read ? this._button(LOGS[k].title, () => onOpen(k), 'log-item', 'log') : this._button('Journal introuvable', () => {}, 'log-item unread', 'log', '???');
      b.dataset.log = k;
      if (!read) b.disabled = true;
      list.appendChild(b);
    }
    box.appendChild(list);
    if (!save.world.logs.length) box.appendChild(el('p', 'small', 'Les terminaux des épaves et des stations gardent la mémoire du secteur.'));
    ov.appendChild(box);
    this._show('logs', ov, { onBack });
  }

  // ---------------------------------------------------------------- death

  showDeath(d, { onRespawn }) {
    const save = this.game.save;
    const ov = el('div', 'ov ov-red');
    const box = el('div', 'panel wide death');
    box.appendChild(el('h2', 'red', 'Signal perdu'));
    box.appendChild(el('p', 'lead', d.causeText));
    if (d.cause !== 'recall') box.appendChild(el('p', 'beacon', 'Balise de rappel activée : retour à l’épave de l’Albatros.'));
    const cols = el('div', 'cols');
    const lost = el('div', 'col lost');
    lost.appendChild(el('h3', '', 'Perdu'));
    if (d.lost > 0) {
      const k = el('p', 'k big');
      k.appendChild(icon('salvage', 14));
      k.appendChild(document.createTextNode(`Ferraille transportée : ${fmtN(d.lost)}`));
      lost.appendChild(k);
    } else lost.appendChild(el('p', 'none', 'Rien : tu ne transportais aucune ferraille.'));
    cols.appendChild(lost);
    const kept = el('div', 'col kept');
    kept.appendChild(el('h3', '', 'Conservé'));
    const bank = el('p', 'k big');
    bank.appendChild(icon('salvage', 14));
    bank.appendChild(document.createTextNode(`Ferraille déposée : ${fmtN(d.salvage)}`));
    kept.appendChild(bank);
    const chips = el('div', 'chips');
    for (const k of ITEM_KEYS) {
      if (!save.items[k]) continue;
      const c = el('span', 'chip item');
      c.appendChild(icon(k, 14));
      c.appendChild(document.createTextNode(ITEMS[k].name));
      chips.appendChild(c);
    }
    if (chips.childNodes.length) kept.appendChild(chips);
    else kept.appendChild(el('p', 'none', 'Aucun équipement pour l’instant.'));
    cols.appendChild(kept);
    box.appendChild(cols);
    box.appendChild(el('div', 'statline', `Sortie : ${fmtTime(d.time)} · ${metres(d.distance)} parcourus · Morts : ${d.deaths}`));
    const row = el('div', 'row');
    row.appendChild(this._button('Repartir', onRespawn, 'primary', 'respawn'));
    box.appendChild(row);
    ov.appendChild(box);
    this._show('death', ov, { onBack: null });
  }

  // ---------------------------------------------------------------- victory

  showVictory(v, { onContinue, onTitle }) {
    const ov = el('div', 'ov ov-win');
    const canvas = el('canvas', 'cine');
    ov.appendChild(canvas);
    const skipBar = el('div', 'cine-bar');
    const panelUp = () => {
      skipBar.remove();
      const box = el('div', 'panel wide victory');
      box.appendChild(pixelLogo('DE RETOUR SUR TERRE', Math.max(2, Math.min(5, Math.floor(window.innerHeight / 90))), '#ffe9a8', '#ffffff', '#2a1a06'));
      box.appendChild(el('p', 'lead', 'Le Module Ulysse a amerri dans l’océan. Neuf jours de dérive, et te voilà chez toi.'));
      const grid = el('div', 'vstats');
      const add = (k, val) => { const c = el('div', 'vs'); c.appendChild(el('span', 'vk', k)); c.appendChild(el('span', 'vv', val)); grid.appendChild(c); };
      add('Temps de jeu', fmtTime(v.time));
      add('Morts', String(v.deaths));
      add('Carte explorée', `${Math.round(v.explored)} %`);
      add('Journaux', `${v.logs}/${v.logsTotal}`);
      add('Ferraille récupérée', fmtN(v.salvageTotal));
      add('Retours sur Terre', String(v.victories));
      box.appendChild(grid);
      const row = el('div', 'row');
      row.appendChild(this._button('Continuer l’exploration', onContinue, 'primary', 'continue'));
      row.appendChild(this._button('Titre', onTitle, 'minor', 'title'));
      box.appendChild(row);
      box.appendChild(el('div', 'small', 'Tu repars de l’Albatros avec tout ton équipement : le secteur a encore des secrets.'));
      ov.appendChild(box);
      ov.classList.add('stats');
      if (!touchFirst()) row.firstChild.focus();
    };
    skipBar.appendChild(this._button('Passer', () => this.cine.skip(), 'primary close', 'skip'));
    ov.appendChild(skipBar);
    this._show('victory', ov, { onBack: null, focus: false });
    this.cine = new ReentryCinematic(canvas, this.game.view.w, this.game.view.h);
    this.cine.onDone = panelUp;
  }
}

export function createUI(game, root) { return new UI(game, root); }

// ==================================================================== re-entry cinematic

// Phases (s): the capsule leaves the Maelström, Earth grows, re-entry flames, parachute over the
// ocean. Drawn in code on a canvas at the game's internal resolution (CSS upscales it like the
// game canvas) with the capsule sprite and the Earth of sprites.js; discs are scanline spans so
// every pixel stays crisp.
const PHASES = [
  { d: 3.2, text: 'Le Module Ulysse s’arrache au Maelström' },
  { d: 3.6, text: 'Neuf jours plus tard…' },
  { d: 3.0, text: 'Rentrée atmosphérique' },
  { d: 3.8, text: 'Amerrissage : bienvenue sur Terre' },
];
const CINE_TOTAL = PHASES.reduce((s, p) => s + p.d, 0);
const FADE = 0.35;
const EARTH_SIZE_MAX = 0.84; // Earth diameter at the end of the flight, × view height

function disc(g, cx, cy, r, col) {
  g.fillStyle = col;
  cx = Math.round(cx); cy = Math.round(cy);
  const rr = Math.max(0, Math.round(r));
  for (let y = -rr; y <= rr; y++) {
    const hw = Math.floor(Math.sqrt(rr * rr - y * y));
    g.fillRect(cx - hw, cy + y, hw * 2 + 1, 1);
  }
}

function ellipseRing(g, cx, cy, rx, ry, col, t, dots) {
  g.fillStyle = col;
  for (let i = 0; i < dots; i++) {
    const a = t + (i / dots) * Math.PI * 2;
    g.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
  }
}

class ReentryCinematic {
  constructor(canvas, w, h) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.t = 0;
    this.done = false;
    this.onDone = null;
    const cap = getSprite('capsule_ship');
    this.capH = cap ? cap.h : 16;
    const rnd = mulberry32(4242);
    this.stars = new Float32Array(120 * 3);
    for (let i = 0; i < 120; i++) { this.stars[i * 3] = rnd(); this.stars[i * 3 + 1] = rnd(); this.stars[i * 3 + 2] = rnd(); }
    this.resize(w, h);
  }

  resize(w, h) {
    this.w = Math.max(64, w | 0); this.h = Math.max(48, h | 0);
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.g.imageSmoothingEnabled = false;
    this.draw();
  }

  skip() { this.t = Math.max(this.t, CINE_TOTAL); }

  update(dt) {
    this.t += dt;
    if (this.t >= CINE_TOTAL) this.done = true;
    this.draw();
  }

  draw() {
    const g = this.g, t = Math.min(this.t, CINE_TOTAL + 1e3);
    let p = 0, t0 = 0;
    while (p < PHASES.length - 1 && t >= t0 + PHASES[p].d) { t0 += PHASES[p].d; p++; }
    const lt = t - t0, d = PHASES[p].d, k = Math.min(1, lt / d);
    if (p === 0) this._escape(k, lt);
    else if (p === 1) this._earth(k, lt);
    else if (p === 2) this._reentry(k, lt);
    else this._ocean(Math.min(1, lt / d), t);
    // fade through black between phases
    const fade = p < PHASES.length - 1 ? Math.max(0, 1 - (d - lt) / FADE) : 0;
    const fin = p > 0 ? Math.max(0, 1 - lt / FADE) : Math.max(0, 1 - lt / 0.6);
    const a = Math.max(fade, fin);
    if (a > 0) { g.globalAlpha = a; g.fillStyle = '#000'; g.fillRect(0, 0, this.w, this.h); g.globalAlpha = 1; }
    if (!this.done) drawText(g, PHASES[p].text, this.w / 2, Math.round(this.h * 0.08), '#e8f6ff', { align: 'center', outline: '#04101f' });
  }

  _stars(dx, dy, warp) {
    const g = this.g, s = this.stars, W = this.w, H = this.h;
    for (let i = 0; i < 120; i++) {
      const z = s[i * 3 + 2];
      let x = s[i * 3] * W + dx * (0.3 + z), y = s[i * 3 + 1] * H + dy * (0.3 + z);
      if (warp) {
        const cx = W / 2, cy = H / 2;
        const f = 1 + warp * (0.5 + z);
        x = cx + (x - cx) * f; y = cy + (y - cy) * f;
      }
      x = ((x % W) + W) % W; y = ((y % H) + H) % H;
      g.fillStyle = z > 0.7 ? '#ffffff' : z > 0.35 ? '#9fb4d8' : '#4a5a7a';
      g.fillRect(x | 0, y | 0, 1, 1);
    }
  }

  _flame(x, y, len, flick) {
    const g = this.g;
    for (let i = 0; i < len; i++) {
      const w = Math.max(1, Math.round((1 - i / len) * 4 + ((i + flick) % 2)));
      g.fillStyle = i < len * 0.3 ? '#fff4c0' : i < len * 0.65 ? '#ffb347' : '#ff5a2a';
      g.fillRect(Math.round(x - w / 2), Math.round(y + i), w, 1);
    }
  }

  /** The capsule sprite centred on (x, y), integer-scaled. */
  _capsule(x, y, scale = 1) {
    const s = getSprite('capsule_ship');
    if (!s) return;
    const w = s.w * scale, h = s.h * scale;
    this.g.drawImage(s.canvas, 0, 0, s.w, s.h, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
  }

  _escape(k, lt) {
    const g = this.g, W = this.w, H = this.h;
    g.fillStyle = '#05030d'; g.fillRect(0, 0, W, H);
    this._stars(-lt * 6, lt * 3, 0);
    const bx = W * 0.3, by = H * 0.66;
    // accretion disk behind, the horizon, the photon ring, the disk in front
    ellipseRing(g, bx, by, 52, 13, '#7a3a8a', lt * 1.4, 110);
    ellipseRing(g, bx, by, 42, 11, '#ff9a3a', lt * 1.9, 96);
    disc(g, bx, by, 18, '#e8a8ff');
    disc(g, bx, by, 16, '#000000');
    g.fillStyle = '#ffcf7a';
    for (let x = -34; x <= 34; x++) if ((x + Math.floor(lt * 20)) % 3) g.fillRect(Math.round(bx + x), Math.round(by + 2 + Math.abs(x) / 12), 1, 1);
    // the capsule accelerates up and away from the hole
    const e = k * k;
    const cx = bx + 36 + e * W * 0.55, cy = by - 20 - e * H * 0.72;
    this._flame(cx, cy + this.capH / 2, 4 + Math.round(k * 10), Math.floor(lt * 30));
    this._capsule(cx, cy);
  }

  _earth(k, lt) {
    const g = this.g, W = this.w, H = this.h;
    g.fillStyle = '#02030a'; g.fillRect(0, 0, W, H);
    this._stars(0, 0, k * 0.6);
    const earth = celestial.earth;
    if (earth) {
      const s = Math.max(2, Math.round((2 + (H * EARTH_SIZE_MAX - 2) * k * k)));
      g.drawImage(earth, 0, 0, earth.width, earth.height, Math.round(W / 2 - s / 2), Math.round(H * 0.45 - s / 2), s, s);
    }
    const cx = W / 2 + Math.sin(lt * 1.3) * 2, cy = H * 0.84 - k * H * 0.06;
    this._flame(cx, cy + this.capH / 2, 4, Math.floor(lt * 30));
    this._capsule(cx, cy);
  }

  _reentry(k, lt) {
    const g = this.g, W = this.w, H = this.h;
    // upper atmosphere: black to deep blue, the planet's glowing limb below
    for (let y = 0; y < H; y += 4) {
      const f = y / H;
      g.fillStyle = f < 0.4 ? '#050818' : f < 0.7 ? '#0b1a3e' : '#1d3f7a';
      g.fillRect(0, y, W, 4);
    }
    disc(g, W / 2, H * 1.9, H * 1.25, '#ff7a2a');
    disc(g, W / 2, H * 1.9, H * 1.2, '#2a5aa8');
    const shake = Math.round(Math.sin(lt * 53) * 1.2);
    const cx = W / 2 + shake, cy = H * 0.42 + k * H * 0.08;
    const half = this.capH; // drawn ×2
    // the capsule falls base first: a plasma trail streams up behind it, the shock glows below
    const flick = Math.floor(lt * 40);
    for (let i = 0; i < 30; i++) {
      const w = Math.max(1, Math.round(22 - i * 0.65 + ((i + flick) % 3)));
      g.fillStyle = i < 5 ? '#fff6d0' : i < 13 ? '#ffc04a' : i < 22 ? '#ff6a2a' : '#a8321a';
      g.fillRect(Math.round(cx - w / 2), Math.round(cy - half * 0.4 - i * 2), w, 2);
    }
    this._capsule(cx, cy, 2);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = i === 0 ? '#fffbe0' : i === 1 ? '#ffd060' : '#ff7a2a';
      const w = 26 - i * 4 + ((flick + i) % 2) * 2;
      g.fillRect(Math.round(cx - w / 2), Math.round(cy + half + i), w, 1);
    }
  }

  _ocean(k, t) {
    const g = this.g, W = this.w, H = this.h;
    const sea = Math.round(H * 0.72);
    const sky = ['#6fb8ff', '#86c6ff', '#a0d4ff', '#bfe3ff'];
    for (let i = 0; i < 4; i++) { g.fillStyle = sky[i]; g.fillRect(0, Math.round((sea * i) / 4), W, Math.ceil(sea / 4) + 1); }
    disc(g, W * 0.82, H * 0.18, 10, '#fff6c8');
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 3; i++) { const cx = ((i * 97 + t * 4) % (W + 40)) - 20; g.fillRect(Math.round(cx), Math.round(H * (0.2 + i * 0.09)), 26 - i * 5, 3); }
    g.fillStyle = '#1f5fa8'; g.fillRect(0, sea, W, H - sea);
    g.fillStyle = '#2f7fc8';
    for (let y = sea + 3; y < H; y += 5) {
      for (let x = 0; x < W; x += 12) g.fillRect(Math.round(x + ((y * 3 + t * 10) % 12)), y, 5, 1);
    }
    // descent under the parachute, then a gentle bob on the waves
    const e = 1 - (1 - k) * (1 - k);
    const ch = this.capH;
    const floatY = sea - ch * 0.3;
    const cx = W * 0.46 + (k < 1 ? Math.sin(t * 0.9) * 3 : 0);
    const cy = k < 1 ? H * 0.2 + e * (floatY - H * 0.2) : floatY + Math.sin(t * 2.2);
    if (k < 0.98) {
      const top = cy - ch / 2 - 22;
      for (let x = -16; x <= 16; x++) {
        const hgt = Math.round(Math.sqrt(Math.max(0, 256 - x * x)) * 0.55);
        g.fillStyle = ((x + 16) >> 2) % 2 ? '#ffffff' : '#e8483a';
        g.fillRect(Math.round(cx + x), Math.round(top - hgt + 4), 1, hgt);
      }
      g.fillStyle = '#d8dde4';
      for (let i = 0; i <= 4; i++) {
        const sx = cx - 15 + i * 7.5;
        for (let s = 0; s < 20; s++) g.fillRect(Math.round(sx + (cx - sx) * (s / 20)), Math.round(top + 4 + s), 1, 1);
      }
    }
    this._capsule(cx, cy);
    if (k >= 1) {
      // the sea laps at the hull
      g.fillStyle = '#1f5fa8'; g.fillRect(Math.round(cx - 9), sea + 1, 18, Math.ceil(ch / 2));
      g.fillStyle = '#e8f6ff'; g.fillRect(Math.round(cx - 11), sea, 4, 1); g.fillRect(Math.round(cx + 7), sea, 4, 1);
    }
  }
}
