// DOM overlay: status bars, resources, contextual buttons, build menu, pause, toasts, title screen.
import { SURVIVAL } from './config.js';
import { RESOURCES, RESOURCE_ORDER, FOOD_ORDER } from './data/resources.js';
import { BUILDINGS, BUILDING_ORDER } from './data/buildings.js';
import { SPECIES, SPECIES_ORDER } from './data/species.js';
import { BIOMES } from './data/biomes.js';
import { ROLES } from './pack.js';
import { bakeIcon, bakeDino, bakeProps, bakeTiles, makeCanvas } from './sprites.js';
import { TILE_ID } from './tiles.js';

const $ = (s, r = document) => r.querySelector(s);

function scaled(src, s) {
  const c = makeCanvas(src.width * s, src.height * s);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export class Hud {
  constructor({ onPick, onContinue, onNew, audio }) {
    this.onPick = onPick; this.onContinue = onContinue; this.onNew = onNew; this.audio = audio;
    this.game = null;
    this.icons = {};
    for (const id of RESOURCE_ORDER) this.icons[id] = bakeIcon(RESOURCES[id]);
    this.bars = {
      hp: $('.bar.hp'), hunger: $('.bar.hunger'), stamina: $('.bar.stamina'), breath: $('.bar.breath'),
    };
    this.chips = {};
    const res = $('#res');
    for (const id of RESOURCE_ORDER) {
      const el = document.createElement('div');
      el.className = 'chip';
      el.title = RESOURCES[id].name;
      el.appendChild(scaled(this.icons[id], 1));
      const n = document.createElement('span');
      n.textContent = '0';
      el.appendChild(n);
      res.appendChild(el);
      this.chips[id] = { el, n, v: -1 };
    }
    this.toastQ = []; this.toastT = 0;
    this.cache = {};
    this.bindButtons();
  }

  // ------------------------------------------------------------------ wiring
  bindButtons() {
    const tap = (el, fn) => el.addEventListener('pointerup', (e) => { e.preventDefault(); this.audio?.unlock(); fn(e); });
    tap($('[data-hud=eat]'), () => this.game?.eatBest());
    tap($('[data-hud=build]'), () => this.openBuildMenu());
    tap($('[data-hud=pack]'), () => { if (this.game) this.game.pack.toggleRole(); });
    tap($('[data-hud=menu]'), () => this.openPause());
    tap($('[data-build=up]'), () => this.game?.builder.nudge(-1));
    tap($('[data-build=down]'), () => this.game?.builder.nudge(1));
    tap($('[data-build=place]'), () => this.game?.builder.place());
    tap($('[data-build=cancel]'), () => this.game?.builder.cancel());
    for (const el of document.querySelectorAll('[data-close]')) tap(el, () => this.close(el.dataset.close));
    tap($('[data-pause=resume]'), () => this.close('pause'));
    tap($('[data-pause=help]'), () => { $('#help').classList.remove('hidden'); });
    tap($('[data-pause=sound]'), (e) => {
      this.audio.muted = !this.audio.muted;
      if (!this.audio.muted) this.audio.unlock();
      e.target.textContent = `Son : ${this.audio.muted ? 'non' : 'oui'}`;
    });
    tap($('[data-pause=new]'), () => {
      if (!confirm('Commencer une nouvelle partie ? La progression actuelle sera effacée.')) return;
      this.close('pause');
      this.onNew();
    });
  }

  bind(game) {
    this.game = game;
    game.onToast = (m) => this.toast(m);
    const sp = game.player.species;
    $('#who').textContent = `${sp.name}, ${sp.title}`;
    $('#hud').classList.remove('hidden');
    $('#controls').classList.remove('hidden');
    $('#title').classList.add('hidden');
    this.game.inventory.onChange = (id) => this.bump(id);
  }

  unbind() {
    this.game = null;
    $('#hud').classList.add('hidden');
    $('#controls').classList.add('hidden');
    $('#buildbar').classList.add('hidden');
  }

  close(id) {
    $(`#${id}`).classList.add('hidden');
    if (this.game && ['pause', 'buildmenu'].includes(id)) this.game.paused = !$('#pause').classList.contains('hidden') || !$('#buildmenu').classList.contains('hidden');
  }

  // ------------------------------------------------------------------ per-frame update
  update(dt) {
    const g = this.game;
    if (!g) return;
    const p = g.player, sp = p.species;
    this.setBar('hp', p.hp / sp.hp, p.hp / sp.hp < 0.3);
    this.setBar('hunger', p.hunger / SURVIVAL.hungerMax, p.hunger < 20);
    this.setBar('stamina', p.stamina / SURVIVAL.staminaMax, p.exhausted, p.stamina >= SURVIVAL.staminaMax && p.state !== 'climb');
    this.setBar('breath', p.breath / sp.breath, p.breath < sp.breath * 0.3, !p.submerged && p.breath >= sp.breath);
    for (const id of RESOURCE_ORDER) {
      const c = this.chips[id], v = g.inventory.count(id);
      if (c.v !== v) { c.v = v; c.n.textContent = String(v); }
    }
    const hasFood = FOOD_ORDER.some((id) => g.inventory.count(id) > 0);
    this.set('eat', hasFood, () => { $('[data-hud=eat]').disabled = !hasFood; });
    const packTxt = `Meute ${g.allies.length}/${g.pack.capacity()} · ${ROLES[g.pack.role].name}`;
    this.set('pack', packTxt, () => { $('[data-hud=pack]').textContent = packTxt; });
    const biome = BIOMES[g.world.biomeAtPx(p.cx)];
    const where = `Jour ${g.day} ${g.isNight ? '☾' : '☀'} · ${biome.name}`;
    this.set('where', where, () => { $('#where').textContent = where; });

    // contextual interact button
    const it = g.builder.active ? { label: 'Poser' } : g.interactTarget;
    const lbl = it ? it.label : 'Interagir';
    this.set('ilabel', lbl + !!it, () => {
      $('#ilabel').textContent = lbl;
      const b = $('[data-btn=interact]');
      b.classList.toggle('active', !!it);
      b.classList.toggle('idle', !it);
    });
    this.set('swimlit', p.inWater, () => $('[data-btn=swim]').classList.toggle('lit', p.inWater));
    this.set('climblit', p.state === 'climb', () => $('[data-btn=climb]').classList.toggle('lit', p.state === 'climb'));

    // build bar
    const bb = $('#buildbar');
    if (g.builder.active) {
      bb.classList.remove('hidden');
      const v = g.builder.validate();
      const name = g.builder.def.name;
      this.set('bname', name, () => { $('#bname').textContent = name; });
      const r = v.ok ? 'Emplacement valide' : v.reason;
      this.set('breason', r, () => { const e = $('#breason'); e.textContent = r; e.classList.toggle('ok', v.ok); });
    } else if (!bb.classList.contains('hidden')) bb.classList.add('hidden');

    // toasts
    this.toastT -= dt;
    const t = $('#toast');
    if (this.toastT <= 0) {
      if (this.toastQ.length) {
        const m = this.toastQ.shift();
        t.textContent = m;
        t.classList.add('show');
        this.toastT = Math.min(6, 2.2 + m.length * 0.04);
      } else t.classList.remove('show');
    }
    const portrait = window.innerHeight > window.innerWidth;
    this.set('rotate', portrait, () => $('#rotate').classList.toggle('hidden', !portrait));
  }

  /** Run fn only when `v` changed (avoids DOM writes every frame). */
  set(key, v, fn) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    fn();
  }

  setBar(id, f, low, hide = false) {
    const k = `${Math.round(f * 200)}|${low}|${hide}`;
    this.set(`bar-${id}`, k, () => {
      const b = this.bars[id];
      b.firstElementChild.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
      b.classList.toggle('low', !!low);
      if (id === 'stamina' || id === 'breath') b.style.visibility = hide ? 'hidden' : 'visible';
    });
  }

  bump(id) {
    const ids = id ? [id] : RESOURCE_ORDER;
    for (const i of ids) {
      const el = this.chips[i]?.el;
      if (!el) continue;
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  }

  toast(m) {
    if (this.toastQ[this.toastQ.length - 1] === m || $('#toast').textContent === m && this.toastT > 0) return;
    this.toastQ.push(m);
    if (this.toastQ.length > 4) this.toastQ.shift();
  }

  // ------------------------------------------------------------------ menus
  openBuildMenu() {
    const g = this.game;
    if (!g) return;
    if (g.builder.active) { g.builder.cancel(); return; }
    if (!this.buildThumbs) {
      const props = bakeProps(), tiles = bakeTiles();
      this.buildThumbs = {};
      for (const id of BUILDING_ORDER) {
        const d = BUILDINGS[id];
        const c = makeCanvas(32, 24);
        const x = c.getContext('2d');
        if (props[id]) { const im = props[id][0]; x.drawImage(im, (32 - im.width) >> 1, 24 - im.height); } else {
          d.pattern.forEach((row, ry) => [...row].forEach((ch, rx) => {
            if (ch !== ' ') x.drawImage(tiles[TILE_ID[d.tiles[ch]]][0], 16 - row.length * 4 + rx * 8, 24 - d.pattern.length * 8 + ry * 8);
          }));
        }
        this.buildThumbs[id] = c;
      }
    }
    const list = $('#blist');
    list.textContent = '';
    for (const id of BUILDING_ORDER) {
      const d = BUILDINGS[id];
      const ok = g.inventory.canAfford(d.cost);
      const row = document.createElement('div');
      row.className = 'bitem';
      row.appendChild(scaled(this.buildThumbs[id], 1));
      const txt = document.createElement('div');
      txt.className = 'txt';
      txt.innerHTML = `<div class="nm"></div><div class="ds"></div><div class="cost"></div>`;
      txt.querySelector('.nm').textContent = d.name;
      txt.querySelector('.ds').textContent = d.desc;
      const cost = txt.querySelector('.cost');
      for (const [rid, n] of Object.entries(d.cost)) {
        const s = document.createElement('span');
        const have = g.inventory.count(rid);
        s.className = have >= n ? '' : 'miss';
        s.appendChild(scaled(this.icons[rid], 1));
        s.append(` ${n} ${RESOURCES[rid].name} (${have})`);
        cost.appendChild(s);
      }
      row.appendChild(txt);
      const b = document.createElement('button');
      b.className = 'hbtn ok';
      b.textContent = 'Placer';
      b.disabled = !ok;
      b.dataset.bid = id;
      b.addEventListener('pointerup', (e) => {
        e.preventDefault();
        if (b.disabled) return;
        g.builder.start(id);
        this.close('buildmenu');
        this.toast(`Place ${d.name} devant toi, puis appuie sur Poser.`);
      });
      row.appendChild(b);
      list.appendChild(row);
    }
    $('#buildmenu').classList.remove('hidden');
    g.paused = true;
  }

  openPause() {
    const g = this.game;
    if (!g) return;
    const s = g.stats;
    $('#pstats').innerHTML = '';
    const lines = [
      `${g.player.species.name} — jour ${g.day}`,
      `Proies abattues : ${s.kills} · Alliés apprivoisés : ${s.tamed}`,
      `Constructions : ${s.built} · Morts : ${s.deaths}`,
    ];
    for (const l of lines) { const d = document.createElement('div'); d.textContent = l; $('#pstats').appendChild(d); }
    $('#pause').classList.remove('hidden');
    g.paused = true;
    g.save();
  }

  // ------------------------------------------------------------------ title
  showTitle(save) {
    this.unbind();
    this.titleSave = save;
    $('#title').classList.remove('hidden');
    const cont = $('#continue');
    cont.textContent = '';
    if (save && SPECIES[save.species]) {
      cont.classList.remove('hidden');
      const t = document.createElement('span');
      t.textContent = `Partie en cours : ${SPECIES[save.species].name}, jour ${Math.floor((save.clock || 0) / 360) + 1}`;
      const b = document.createElement('button');
      b.className = 'hbtn ok';
      b.dataset.act = 'continue';
      b.textContent = 'Continuer';
      b.addEventListener('pointerup', (e) => { e.preventDefault(); this.audio?.unlock(); this.onContinue(); });
      cont.append(t, b);
    } else cont.classList.add('hidden');

    const cards = $('#cards');
    if (cards.childElementCount) return;
    const labels = { saut: 'Saut', escalade: 'Escalade', nage: 'Nage', vitesse: 'Vitesse', combat: 'Combat', defense: 'Défense' };
    for (const id of SPECIES_ORDER) {
      const s = SPECIES[id];
      const card = document.createElement('div');
      card.className = 'card';
      const img = bakeDino(s.look).idle0[0];
      const k = Math.max(2, Math.floor(80 / img.width));
      card.appendChild(scaled(img, k));
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = s.name;
      const tt = document.createElement('div'); tt.className = 'tt'; tt.textContent = s.title;
      const bl = document.createElement('div'); bl.className = 'bl'; bl.textContent = s.blurb;
      const st = document.createElement('div'); st.className = 'st';
      for (const [key, lab] of Object.entries(labels)) {
        const l = document.createElement('span'); l.textContent = lab;
        const pips = document.createElement('span'); pips.className = 'pips';
        for (let i = 1; i <= 5; i++) { const p = document.createElement('i'); if (i <= s.ratings[key]) p.className = 'on'; pips.appendChild(p); }
        st.append(l, pips);
      }
      const b = document.createElement('button');
      b.className = 'hbtn ok';
      b.dataset.pick = id;
      b.textContent = `Jouer ${s.name}`;
      b.addEventListener('pointerup', (e) => {
        e.preventDefault();
        this.audio?.unlock();
        if (this.titleSave && !confirm('Commencer une nouvelle partie ? La partie en cours sera effacée.')) return;
        this.onPick(id);
      });
      card.append(nm, tt, bl, st, b);
      cards.appendChild(card);
    }
  }
}
