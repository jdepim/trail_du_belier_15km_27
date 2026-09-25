// DOM overlays styled gothic (DESIGN.md §9): title, settings, pause, Forge, death, victory.
//
//   showTitle({ runActive, runDepth, onPlay, onSettings })
//   showSettings({ storage, onToggleMute, onToggleShake, onErase, onBack })
//   showPause({ run, player, canAbandon, onResume, onAbandon, onTitle, onToggleMute })
//   showShop({ onBuy(key) -> buyUpgrade result, onClose })
//   showDeath(summary, { onRestart, onTitle })        summary = meta.settleDeath()
//   showVictory(info, { onContinue, onTitle })
//   hide(), relayout(), refresh(), notice(text), back(), activate(), open, name
//
// Keyboard: arrows / WASD move the focus spatially between buttons, Entrée / Espace /
// Z / X press the focused one (or the panel's default), Échap / P go back (E closes
// the Forge). Those keys are captured before input.js while an overlay is open, so a
// menu key never leaks into the game. Gamepad / injected presses reach back() and
// activate() through main.js (the pad stick / D-pad moves the focus). Touch: buttons press
// on pointerup of the finger that went down on them, so they work while another finger
// still rests on the screen (the stick thumb); the click that follows is ignored.
// Destructive confirmations ("Effacer définitivement", "Abandonner") sit after "Annuler"
// and stay disabled for CONFIRM_ARM ms, so a double tap can never confirm by accident.
// Safe areas are the overlay padding; the Forge list scrolls on its own if it overflows.
import { drawText, measureText } from './hud.js';
import { makeIcon } from './sprites.js';
import { UPGRADES, UPGRADE_KEYS, upgradeCost, RELICS } from './meta.js';
import { ENEMY_SCALING } from './config.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const fmtN = (n) => Math.round(n || 0).toLocaleString('fr-FR');
function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min ${String(sec).padStart(2, '0')} s`;
}

/** Death causes (player.takeDamage opts.cause / game.abandonRun). */
const CAUSES = {
  slime: 'Dévoré par une gelée', bat: 'Saigné par une chauve-souris', skeleton: 'Terrassé par un squelette',
  spider: 'Empoisonné par une araignée', ghost: 'Hanté par un spectre', imp: 'Carbonisé par un diablotin',
  golem: 'Écrasé par un golem', guardian: 'Anéanti par le Gardien de l’Abysse', bone: 'Assommé par un os',
  fireball: 'Brûlé par une boule de feu', shock: 'Balayé par l’onde de choc', meteor: 'Écrasé par la pluie de feu',
  lava: 'Englouti par la lave', abandon: 'Expédition abandonnée', enemy: 'Tombé dans les profondeurs',
};
export function causeText(cause) { return CAUSES[cause] || CAUSES.enemy; }

/** Crisp pixel-font logo rendered to a canvas and upscaled with CSS. */
function pixelLogo(text, cssScale, colors = ['#e8c878', '#3a0610']) {
  const w = measureText(text) + 4, h = 13;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  drawText(g, text, 2, 3, colors[0], { outline: colors[1] });
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

function icon(name, px, cls = 'pix') {
  const c = makeIcon(name, px);
  if (!c) return el('span');
  c.className = cls;
  return c;
}

const NAV = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
const OK_KEYS = { Enter: 1, NumpadEnter: 1, Space: 1, KeyZ: 1, KeyX: 1, KeyJ: 1 };
const CONFIRM_ARM = 550;   // ms a destructive confirm button stays disabled after it appears
const CLICK_GUARD = 700;   // ms after a touch press during which the synthetic click is ignored
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const BACK_KEYS = { Escape: 1, KeyP: 1 };

export class UI {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.current = null;
    this.name = null;
    this.noticeEl = null;
    this.touchPressT = -1e9; // last button pressed by a touch (pointerup)
    this.pressPt = { x: 0, y: 0, ok: false }; // where the last button press happened (CSS px)
    // captured before input.js (window capture phase), only while an overlay is open
    if (typeof window !== 'undefined') window.addEventListener('keydown', (e) => this._onKey(e), true);
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

  /** Re-render the current overlay's live parts (mute label changed by the M key...). */
  refresh() { if (this.current && this.current._refresh) this.current._refresh(); }

  /** Transient message over everything (corrupted save...). */
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
    if (focus && !('ontouchstart' in window)) {
      const first = panel.querySelector('.gbtn.primary:not(:disabled)') || panel.querySelector('button:not(:disabled)');
      if (first) first.focus({ preventScroll: true });
    }
  }

  _button(label, onClick, cls = '', act = null, sub = null) {
    const b = el('button', 'gbtn ' + cls);
    b.type = 'button';
    b.appendChild(el('span', 'lbl', label));
    if (sub) b.appendChild(el('span', 'sub', sub));
    if (act) b.dataset.act = act;
    this._bindPress(b, () => {
      this.game.audio.unlock();
      this.game.audio.play('ui');
      onClick(b);
    });
    return b;
  }

  /**
   * Press handling for overlay buttons. Touch / pen: the finger that went down on the
   * button presses it on pointerup (browsers only turn single-finger taps into clicks,
   * so a thumb resting on the stick would make click-only buttons dead); sliding off
   * cancels. Mouse / keyboard / ui.activate(): the click. The click that a touch
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

  /**
   * A destructive confirm button must not appear under the finger that opened the
   * confirmation (a second tap would land on it): push it down until it clears the
   * last press point (the panel is centred, so it moves half the added margin).
   */
  _keepClear(b) {
    const pt = this.pressPt;
    if (!pt.ok || !b.isConnected) return;
    for (let i = 0; i < 4; i++) {
      const r = b.getBoundingClientRect();
      const pad = 16; // touch-adjustment radius around the finger
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

  // ---------------------------------------------------------------- keyboard / pad

  _buttons() {
    if (!this.current) return [];
    return [...this.current.querySelectorAll('button:not(:disabled)')].filter((b) => b.offsetParent !== null);
  }

  _onKey(e) {
    if (!this.current) return;
    const k = e.code;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (NAV[k]) { stop(); this.move(NAV[k][0], NAV[k][1]); return; }
    if (OK_KEYS[k]) { stop(); if (!e.repeat) this.activate(); return; }
    if (BACK_KEYS[k] || (k === 'KeyE' && this.name === 'shop')) { stop(); if (!e.repeat) this.back(); }
  }

  /** Move the focus to the nearest button in direction (dx, dy). */
  move(dx, dy) {
    const list = this._buttons();
    if (!list.length) return;
    const cur = list.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { this._default().focus({ preventScroll: false }); return; }
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bestS = Infinity;
    for (const b of list) {
      if (b === cur) continue;
      const r = b.getBoundingClientRect();
      const vx = r.left + r.width / 2 - cx, vy = r.top + r.height / 2 - cy;
      const fwd = vx * dx + vy * dy;
      if (fwd <= 4) continue;
      const score = fwd + Math.abs(vx * dy - vy * dx) * 2.2;
      if (score < bestS) { bestS = score; best = b; }
    }
    if (!best) {
      // wrap around: the farthest button the other way, closest to the same column / row
      for (const b of list) {
        if (b === cur) continue;
        const r = b.getBoundingClientRect();
        const vx = r.left + r.width / 2 - cx, vy = r.top + r.height / 2 - cy;
        const back = -(vx * dx + vy * dy);
        if (back <= 4) continue;
        const score = -back + Math.abs(vx * dy - vy * dx) * 2.2;
        if (score < bestS) { bestS = score; best = b; }
      }
    }
    if (best) { best.focus({ preventScroll: false }); best.scrollIntoView && best.scrollIntoView({ block: 'nearest' }); }
  }

  _default() {
    const list = this._buttons();
    return (this.current && (this.current.querySelector('.gbtn.primary:not(:disabled)'))) || list[0];
  }

  /** Press the focused button, or the panel's default one. */
  activate() {
    if (!this.current) return;
    const f = document.activeElement;
    const b = f && this.current.contains(f) && f.tagName === 'BUTTON' && !f.disabled ? f : this._default();
    if (b) b.click();
  }

  /** Échap / P / pad B: the panel's back action (resume, close, return). */
  back() { if (this.current && this.current._onBack) this.current._onBack(); }

  // ---------------------------------------------------------------- title & settings

  showTitle({ runActive = false, runDepth = 0, onPlay, onSettings }) {
    const save = this.game.save;
    const st = save.stats;
    const progress = st.runs > 0 || save.gold > 0 || st.trips > 0;
    const ov = el('div', 'ov ov-title');
    const box = el('div', 'title-box');
    box.appendChild(pixelLogo('GOUFFRE', logoScale()));
    box.appendChild(el('div', 'tagline', 'Creuse. Descends. Remonte vivant.'));
    let label = 'Jouer', sub = null;
    if (runActive) { label = 'Continuer'; sub = runDepth > 0 ? `Expédition en cours · −${runDepth} m` : 'Expédition en cours'; }
    else if (progress) { label = 'Continuer'; sub = `Or banqué : ${fmtN(save.gold)}${st.bestDepth ? ` · record −${st.bestDepth} m` : ''}`; }
    const play = this._button(label, onPlay, 'primary', 'play', sub);
    box.appendChild(play);
    box.appendChild(this._button('Réglages', onSettings, 'minor', 'settings'));
    if (progress) {
      const bits = [`Expéditions : ${st.runs}`, `Morts : ${st.deaths}`];
      if (st.victories) bits.push(`Victoires : ${st.victories}`);
      if (save.ngPlus) bits.push(`NG+ ${save.ngPlus}`);
      box.appendChild(el('div', 'small', bits.join(' · ')));
    }
    box.appendChild(el('div', 'small keys', 'Clavier : ← → ↑ ↓ · Espace saut · X frapper · C grappin · E forge · Échap pause'));
    ov.appendChild(box);
    this._show('title', ov);
  }

  showSettings({ storage = true, onToggleMute, onToggleShake, onErase, onBack }) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel');
    box.appendChild(el('h2', '', 'Réglages'));
    const soundLabel = () => (this.game.audio.muted ? 'Son : coupé' : 'Son : activé');
    const shakeLabel = () => (this.game.save.settings.shake !== false ? 'Secousses : oui' : 'Secousses : non');
    const mute = this._button(soundLabel(), () => { onToggleMute(); mute.firstChild.textContent = soundLabel(); }, '', 'mute');
    const shake = this._button(shakeLabel(), () => { onToggleShake(); shake.firstChild.textContent = shakeLabel(); }, '', 'shake');
    box.append(mute, shake);
    const erase = this._button('Effacer la sauvegarde', () => confirmErase(), 'danger', 'erase');
    box.appendChild(erase);
    if (!storage) box.appendChild(el('p', 'notice', 'Stockage indisponible (navigation privée ?) : la progression ne sera pas conservée.'));
    const msg = el('p', 'msg');
    box.appendChild(msg);
    box.appendChild(this._button('Retour', onBack, 'primary', 'back'));
    ov.appendChild(box);
    ov._refresh = () => { mute.firstChild.textContent = soundLabel(); };
    const confirmErase = () => {
      box.replaceChildren();
      box.appendChild(el('h2', 'red', 'Tout effacer ?'));
      box.appendChild(el('p', '', 'Or banqué, améliorations de la Forge et statistiques seront perdus à jamais.'));
      const row = el('div', 'row confirm');
      // "Annuler" first: the safe choice comes before (and the red one is armed late)
      row.appendChild(this._button('Annuler', () => this.showSettings({ storage, onToggleMute, onToggleShake, onErase, onBack }), 'primary', 'cancel'));
      row.appendChild(this._arm(this._button('Effacer définitivement', () => {
        onErase();
        this.showSettings({ storage, onToggleMute, onToggleShake, onErase, onBack });
        const m = this.current && this.current.querySelector('.msg');
        if (m) m.textContent = 'Sauvegarde effacée.';
      }, 'danger', 'erase-confirm')));
      box.appendChild(row);
      this._keepClear(row.lastChild);
      this.current._onBack = () => this.showSettings({ storage, onToggleMute, onToggleShake, onErase, onBack });
      if (!('ontouchstart' in window)) row.firstChild.focus();
    };
    this._show('settings', ov, { onBack });
  }

  // ---------------------------------------------------------------- pause

  showPause({ run, player, canAbandon = true, onResume, onAbandon, onTitle, onToggleMute }) {
    const ov = el('div', 'ov ov-dim');
    const box = el('div', 'panel');
    const build = () => {
      box.replaceChildren();
      box.appendChild(el('h2', '', 'Pause'));
      const settled = !!(run && run.over); // (never shown: a pause request during the death animation opens the summary)
      if (run && player && !settled) {
        const bits = [player.depth > 0 ? `−${player.depth} m` : 'Au camp'];
        bits.push(`Sac ${run.bagCount}/${player.stats.bagCapacity}`);
        if (run.gold) bits.push(`${fmtN(run.gold)} or non banqué`);
        if (run.relics.length) bits.push(`${run.relics.length} relique${run.relics.length > 1 ? 's' : ''}`);
        box.appendChild(el('p', 'small', bits.join(' · ')));
      }
      box.appendChild(this._button('Reprendre', onResume, 'primary', 'resume'));
      const mute = this._button(this.game.audio.muted ? 'Son : coupé' : 'Son : activé', () => {
        const m = onToggleMute();
        mute.firstChild.textContent = m ? 'Son : coupé' : 'Son : activé';
      }, '', 'mute');
      box.appendChild(mute);
      // no abandon once the run is settled, nor in the Guardian's last breath (the victory is due)
      if (canAbandon && !settled && !(run && run.bossDefeated)) box.appendChild(this._button('Recommencer l’expédition', confirm, '', 'abandon'));
      box.appendChild(this._button('Retour au titre', onTitle, 'minor', 'title'));
      ov._refresh = () => { mute.firstChild.textContent = this.game.audio.muted ? 'Son : coupé' : 'Son : activé'; };
      if (this.current === ov) this.current._onBack = onResume;
    };
    const confirm = () => {
      box.replaceChildren();
      box.appendChild(el('h2', 'red', 'Abandonner ?'));
      const ins = player ? player.stats.insurance : 0;
      const loot = run && (run.bagCount || run.gold);
      let txt = 'L’expédition compte comme une mort et la mine sera régénérée.';
      if (loot) txt += ins > 0 ? ` Ton butin non banqué sera perdu (Bourse de secours : ${Math.round(ins * 100)} % conservés).` : ' Ton butin non banqué sera perdu.';
      box.appendChild(el('p', '', txt));
      const row = el('div', 'row confirm');
      row.appendChild(this._button('Annuler', () => { build(); focusFirst(); }, 'primary', 'cancel'));
      row.appendChild(this._arm(this._button('Abandonner', onAbandon, 'danger', 'abandon-confirm')));
      box.appendChild(row);
      this._keepClear(row.lastChild);
      this.current._onBack = () => { build(); focusFirst(); };
      if (!('ontouchstart' in window)) row.firstChild.focus();
    };
    const focusFirst = () => { if (!('ontouchstart' in window)) { const b = box.querySelector('button'); if (b) b.focus(); } };
    build();
    ov.appendChild(box);
    this._show('pause', ov, { onBack: onResume });
  }

  // ---------------------------------------------------------------- the Forge

  showShop({ onBuy, onClose }) {
    const game = this.game;
    const ov = el('div', 'ov ov-forge');
    const wrap = el('div', 'forge');
    const head = el('div', 'forge-head');
    const title = el('div', 'forge-title');
    title.appendChild(icon('up_pick', 22));
    title.appendChild(el('h2', '', 'La Forge'));
    head.appendChild(title);
    const pill = el('div', 'gold-pill');
    pill.appendChild(icon('icon_coin', 16));
    const goldTxt = el('span', 'gold-val', fmtN(game.save.gold));
    pill.appendChild(goldTxt);
    pill.title = 'Or banqué';
    head.appendChild(pill);
    const close = this._button('Retour', onClose, 'close', 'close');
    head.appendChild(close);
    wrap.appendChild(head);
    const grid = el('div', 'forge-grid');
    wrap.appendChild(grid);
    const foot = el('div', 'forge-foot', 'Seul l’or banqué compte : remonte ton butin au camp pour le mettre à l’abri.');
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
        ic.appendChild(icon(u.icon, 28));
        const pips = el('span', 'pips');
        for (let i = 0; i < u.max; i++) pips.appendChild(el('i', 'pip'));
        ic.appendChild(pips);
        c.appendChild(ic);
        const mid = el('div', 'mid');
        const nm = el('div', 'nm');
        nm.appendChild(el('span', 'nm-t', u.name));
        mid.appendChild(nm);
        mid.appendChild(el('div', 'ds', u.desc));
        mid.appendChild(el('div', 'fx'));
        mid.appendChild(el('div', 'nx'));
        c.appendChild(mid);
        const buy = el('button', 'buy');
        buy.type = 'button';
        buy.dataset.buy = k;
        this._bindPress(buy, () => {
          game.audio.unlock();
          const r = onBuy(k);
          if (r && r.ok) {
            renderAll();
            c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
            const pipsEl = c.querySelectorAll('.pip');
            if (pipsEl[r.level - 1]) pipsEl[r.level - 1].classList.add('new');
            foot.textContent = `${u.name} : niveau ${r.level} ! ${u.effect(r.level)}`;
            foot.classList.add('ok');
            const fl = el('span', 'spent', `−${fmtN(r.cost)}`);
            pill.appendChild(fl);
            setTimeout(() => fl.remove(), 900);
            if (!('ontouchstart' in window)) {
              const b = c.querySelector('.buy');
              if (b.disabled) { const nb = this._buttons().find((x) => x.classList.contains('buy')); if (nb) nb.focus(); else close.focus(); }
            }
          } else if (r) {
            foot.textContent = r.reason === 'max' ? `${u.name} : déjà au maximum.` : `Il te manque ${fmtN(r.cost - game.save.gold)} or.`;
            foot.classList.remove('ok');
          }
        });
        c.appendChild(buy);
        grid.appendChild(c);
      }
      c.title = u.desc;
      c.classList.toggle('maxed', cost === Infinity);
      const pipsEl = c.querySelectorAll('.pip');
      pipsEl.forEach((p, i) => p.classList.toggle('on', i < lv));
      c.querySelector('.fx').textContent = u.effect(lv);
      const nx = c.querySelector('.nx');
      const buy = c.querySelector('.buy');
      buy.replaceChildren();
      if (cost === Infinity) {
        nx.textContent = 'Maîtrise atteinte';
        buy.disabled = true;
        buy.appendChild(el('span', 'b1', 'MAX'));
      } else {
        const unlock = u.unlock ? u.unlock(lv + 1) : null;
        nx.textContent = '→ ' + u.effect(lv + 1) + (unlock ? ` · ${unlock}` : '');
        const afford = game.save.gold >= cost;
        buy.disabled = !afford;
        buy.classList.toggle('poor', !afford);
        const b1 = el('span', 'b1');
        b1.appendChild(icon('icon_coin', 12));
        b1.appendChild(document.createTextNode(fmtN(cost)));
        buy.appendChild(b1);
        buy.appendChild(el('span', 'b2', afford ? 'Forger' : 'Trop cher'));
      }
    };
    const renderAll = () => {
      goldTxt.textContent = fmtN(game.save.gold);
      for (const k of UPGRADE_KEYS) renderCard(k);
    };
    renderAll();
    ov._refresh = renderAll;
    this._show('shop', ov, { onBack: onClose, focus: false });
    if (!('ontouchstart' in window)) {
      const b = this._buttons().find((x) => x.classList.contains('buy'));
      (b || close).focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------- death

  showDeath(d, { onRestart, onTitle }) {
    const ov = el('div', 'ov ov-dim ov-red');
    const box = el('div', 'panel wide death');
    const abandon = d.cause === 'abandon';
    box.appendChild(el('h2', 'red', abandon ? 'Expédition abandonnée' : 'Tu as péri'));
    box.appendChild(el('p', 'lead', `${abandon ? 'Abandon' : 'Mort'} à −${d.depth || 0} m${abandon ? '' : ' · ' + causeText(d.cause)}`));

    const cols = el('div', 'cols');
    const lost = el('div', 'col lost');
    lost.appendChild(el('h3', '', 'Butin perdu'));
    const chips = el('div', 'chips');
    for (const it of d.items || []) {
      const ch = el('span', 'chip');
      ch.appendChild(icon('ore_' + it.key, 12));
      ch.appendChild(document.createTextNode(`${it.name} ×${it.count}`));
      chips.appendChild(ch);
    }
    if (d.gold > 0) {
      const ch = el('span', 'chip gold');
      ch.appendChild(icon('icon_coin', 12));
      ch.appendChild(document.createTextNode(`${fmtN(d.gold)} or`));
      chips.appendChild(ch);
    }
    if (!chips.childNodes.length) chips.appendChild(el('span', 'none', 'Rien : ton sac était vide.'));
    lost.appendChild(chips);
    if (d.relics && d.relics.length) {
      const rl = el('div', 'chips relics');
      for (const k of d.relics) { const r = RELICS[k]; if (!r) continue; const ch = el('span', 'chip relic'); ch.title = r.desc; ch.appendChild(icon(r.icon, 16)); ch.appendChild(document.createTextNode(r.name)); rl.appendChild(ch); }
      lost.appendChild(rl);
    }
    cols.appendChild(lost);

    const kept = el('div', 'col kept');
    kept.appendChild(el('h3', '', 'À l’abri'));
    if (d.insurance > 0) kept.appendChild(el('p', 'k', `Bourse de secours (${Math.round(d.insurance * 100)} %) : +${fmtN(d.kept)} or`));
    else if ((d.oreValue || 0) + (d.gold || 0) > 0) kept.appendChild(el('p', 'k dim', 'Bourse de secours : aucune (Forge)'));
    if (d.banked > 0) kept.appendChild(el('p', 'k', `Banqué pendant l’expédition : ${fmtN(d.banked)} or`));
    const bank = el('p', 'k big');
    bank.appendChild(icon('icon_coin', 14));
    bank.appendChild(document.createTextNode(`Or banqué : ${fmtN(d.bankGold)}`));
    kept.appendChild(bank);
    cols.appendChild(kept);
    box.appendChild(cols);

    const stats = el('div', 'statline');
    const bits = [`Plus profond : −${d.bestDepth || 0} m`, `Ennemis vaincus : ${d.kills || 0}`, `Minerais : ${d.ore || 0}`];
    if (d.chests) bits.push(`Coffres : ${d.chests}`);
    bits.push(`Durée : ${fmtTime(d.time)}`);
    stats.textContent = bits.join(' · ');
    box.appendChild(stats);
    const row = el('div', 'row');
    row.appendChild(this._button('Nouvelle expédition', onRestart, 'primary', 'restart'));
    row.appendChild(this._button('Retour au titre', onTitle, 'minor', 'title'));
    box.appendChild(row);
    ov.appendChild(box);
    this._show('death', ov, { onBack: null });
  }

  // ---------------------------------------------------------------- victory

  showVictory(v, { onContinue, onTitle }) {
    const ov = el('div', 'ov ov-dim ov-gold');
    const box = el('div', 'panel wide victory');
    box.appendChild(pixelLogo('VICTOIRE', Math.max(3, Math.min(6, Math.floor(window.innerHeight / 80))), ['#fff0a0', '#3a2408']));
    box.appendChild(el('p', 'lead', 'Le Gardien de l’Abysse est tombé. Le Cœur du Gouffre bat enfin librement.'));
    const grid = el('div', 'vstats');
    const add = (k, val) => { const c = el('div', 'vs'); c.appendChild(el('span', 'vk', k)); c.appendChild(el('span', 'vv', val)); grid.appendChild(c); };
    add('Durée de l’expédition', fmtTime(v.time));
    add('Ennemis vaincus', String(v.kills || 0));
    add('Or rapporté', fmtN(v.banked));
    add('Morts', String(v.deaths || 0));
    add('Victoires', String(v.victories || 1));
    add('Or banqué', fmtN(v.bankGold));
    box.appendChild(grid);
    if (v.relics && v.relics.length) {
      const rl = el('div', 'chips relics center');
      for (const k of v.relics) { const r = RELICS[k]; if (!r) continue; const ch = el('span', 'chip relic'); ch.title = r.desc; ch.appendChild(icon(r.icon, 16)); ch.appendChild(document.createTextNode(r.name)); rl.appendChild(ch); }
      box.appendChild(rl);
    }
    const next = (v.ngPlus || 0) + 1;
    const mul = String(1 + (ENEMY_SCALING.ngPlusMul - 1) * next).replace('.', ',');
    const row = el('div', 'row');
    row.appendChild(this._button(`Continuer (NG+ ${next})`, onContinue, 'primary', 'ngplus'));
    row.appendChild(this._button('Retour au titre', onTitle, 'minor', 'title'));
    box.appendChild(row);
    box.appendChild(el('div', 'small', `NG+ ${next} : nouvelle mine, ennemis ×${mul}. Tes améliorations sont conservées.`));
    ov.appendChild(box);
    this._show('victory', ov, { onBack: null });
  }
}

export function createUI(game, root) { return new UI(game, root); }
