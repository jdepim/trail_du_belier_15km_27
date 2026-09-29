// Synthesized WebAudio (DESIGN §11): one-shot effects, continuous loops and a procedural ambience per
// zone. No audio file. The AudioContext is created / resumed on the first user gesture (iOS) and woken
// from WebKit's iOS-only "interrupted" state (calls, Siri) as well as "suspended".
//
//   createAudio() -> AudioSystem
//     play(name, opts?)        opts { volume 0..1, pitch ×, material } (read synchronously, never kept);
//                              rapid repeats of the same sound + material are throttled (30 ms)
//     setLoop(name, level)     'thrust' | 'brake' | 'heat' | 'rumble' | 'alarm' | 'storm', level 0..1
//                              (smoothed; cheap to call every frame: tiny changes are ignored)
//     setZone(key)             ambience: 'space' | 'interior' | 'selene' | 'twins' | 'maelstrom' | 'storm' |
//                              'title' | 'victory' (unknown -> 'space', null -> silence)
//     setMuted(b), toggleMute() -> muted, muted (getter), unlock(), suspend(), resume()
//     tick() / update()        once per frame: distant ambience notes (Renderer.render calls tick)
// Muting is not persisted here: the save (settings.muted) is the source of truth, main applies it.
// Sounds: see SFX below (every name the simulation emits, plus deposit buy ui ui_back map pause
// respawn victory warning tip log).
import { AUDIO_MIX } from './render-config.js';

const PENTA = [0, 3, 5, 7, 10, 12, 15, 17];
const ZONES = {
  space: { root: 55, chord: [0, 7, 14.02], cutoff: 380, noise: 0.012, bell: [5, 10], bellOct: 8, bellType: 'sine', vol: 0.05 },
  interior: { root: 49, chord: [0, 0.07, 12], cutoff: 260, noise: 0.03, bell: [7, 13], bellOct: 4, bellType: 'triangle', vol: 0.045 },
  selene: { root: 41.2, chord: [0, 5, 12], cutoff: 300, noise: 0.022, bell: [6, 11], bellOct: 6, bellType: 'sine', vol: 0.05 },
  twins: { root: 61.7, chord: [0, 4, 7], cutoff: 620, noise: 0.028, bell: [4, 8], bellOct: 8, bellType: 'triangle', vol: 0.045 },
  maelstrom: { root: 36.7, chord: [0, 1, 6], cutoff: 220, noise: 0.03, bell: [8, 14], bellOct: 3, bellType: 'sawtooth', vol: 0.06 },
  storm: { root: 46.2, chord: [0, 6, 13], cutoff: 900, noise: 0.05, bell: [3, 6], bellOct: 10, bellType: 'square', vol: 0.035 },
  title: { root: 55, chord: [0, 7, 16], cutoff: 520, noise: 0.01, bell: [3, 6], bellOct: 8, bellType: 'sine', vol: 0.055 },
  victory: { root: 65.4, chord: [0, 4, 7], cutoff: 900, noise: 0.006, bell: [0.6, 1.4], bellOct: 8, bellType: 'triangle', vol: 0.06 },
};

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._muted = false;
    this.unlocked = false;
    this.last = {};
    this.loops = null;
    this.levels = { thrust: 0, brake: 0, heat: 0, rumble: 0, alarm: 0, storm: 0 };
    this.zone = null;
    this.music = null;
    this.nextBell = 0;
    this.debug = false;
  }

  get muted() { return this._muted; }

  /** Create / resume the context. Must run inside a user gesture on iOS. */
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const c = new AC();
        this.ctx = c;
        this.master = c.createGain();
        this.master.gain.value = this._muted ? 0 : AUDIO_MIX.master;
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 4;
        this.master.connect(comp); comp.connect(c.destination);
        this.sfx = c.createGain(); this.sfx.gain.value = AUDIO_MIX.sfx; this.sfx.connect(this.master);
        this.musicBus = c.createGain(); this.musicBus.gain.value = AUDIO_MIX.music; this.musicBus.connect(this.master);
        this.noiseBuf = this._makeNoise(c.sampleRate, false);
        this.crackleBuf = this._makeNoise(c.sampleRate, true);
        this._buildLoops();
        if (this.zone) { const z = this.zone; this.zone = null; this.setZone(z); }
      }
      this._wake();
      if (!this.unlocked) {
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
        this.unlocked = true;
      }
    } catch (e) { if (this.debug) console.warn('audio unlock', e); }
  }

  suspend() {
    try { if (this.ctx && this.ctx.state === 'running') { const r = this.ctx.suspend(); if (r && r.catch) r.catch(() => {}); } } catch { /* ignore */ }
  }

  resume() { try { this._wake(); } catch { /* ignore */ } }

  /**
   * Resume from any non-running state: 'suspended', and WebKit's iOS-only 'interrupted' (phone call,
   * Siri, alarm), which never auto-resumes reliably. The promise can reject outside a user gesture:
   * swallow it, the next touch (unlock) tries again.
   */
  _wake() {
    const c = this.ctx;
    if (!c || c.state === 'running' || c.state === 'closed') return;
    const r = c.resume();
    if (r && r.catch) r.catch(() => {});
  }

  setMuted(b) {
    this._muted = !!b;
    if (this.master) this.master.gain.setTargetAtTime(this._muted ? 0 : AUDIO_MIX.master, this.ctx.currentTime, 0.03);
  }

  toggleMute() { this.setMuted(!this._muted); return this._muted; }

  _makeNoise(rate, crackle) {
    const len = rate * 2;
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    let seed = crackle ? 777 : 12345;
    let env = 0;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const r = (seed / 4294967296) * 2 - 1;
      if (!crackle) { d[i] = r; continue; }
      // sparse pops with a fast decay: fire / static crackle
      if (((seed >>> 8) & 1023) < 3) env = 0.6 + 0.4 * Math.abs(r);
      env *= 0.985;
      d[i] = r * env;
    }
    return buf;
  }

  // ------------------------------------------------------------ loops

  _src(buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(0, Math.random() * 1.5);
    return s;
  }

  _buildLoops() {
    const c = this.ctx;
    const mk = () => { const g = c.createGain(); g.gain.value = 0; g.connect(this.sfx); return g; };
    const L = {};
    // thrust: low-passed hiss whose brightness follows the throttle
    L.thrust = { gain: mk() };
    L.thrust.filter = c.createBiquadFilter(); L.thrust.filter.type = 'lowpass'; L.thrust.filter.frequency.value = 600; L.thrust.filter.Q.value = 0.8;
    this._src(this.noiseBuf).connect(L.thrust.filter); L.thrust.filter.connect(L.thrust.gain);
    // brake: high hiss (cold gas)
    L.brake = { gain: mk() };
    const bf = c.createBiquadFilter(); bf.type = 'highpass'; bf.frequency.value = 2200;
    this._src(this.noiseBuf).connect(bf); bf.connect(L.brake.gain);
    // heat: crackle
    L.heat = { gain: mk() };
    const hf = c.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 900;
    this._src(this.crackleBuf).connect(hf); hf.connect(L.heat.gain);
    // rumble: two detuned sub sines + dark noise, slow wobble
    L.rumble = { gain: mk() };
    for (const f of [34, 51.5]) { const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(L.rumble.gain); o.start(); }
    const rf = c.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 140;
    const rn = c.createGain(); rn.gain.value = 0.6;
    this._src(this.noiseBuf).connect(rf); rf.connect(rn); rn.connect(L.rumble.gain);
    const wob = c.createOscillator(); wob.frequency.value = 0.4;
    const wobG = c.createGain(); wobG.gain.value = 60;
    wob.connect(wobG); wobG.connect(rf.frequency); wob.start();
    // alarm: square beeps gated by a square LFO (0..1)
    L.alarm = { gain: mk() };
    const ao = c.createOscillator(); ao.type = 'square'; ao.frequency.value = 880;
    const gate = c.createGain(); gate.gain.value = 0.5;
    const lfo = c.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 2.2;
    const lfoG = c.createGain(); lfoG.gain.value = 0.5;
    lfo.connect(lfoG); lfoG.connect(gate.gain);
    ao.connect(gate); gate.connect(L.alarm.gain); ao.start(); lfo.start();
    // storm: band-passed static + crackle, fluttering
    L.storm = { gain: mk() };
    const sf = c.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 2600; sf.Q.value = 0.7;
    this._src(this.noiseBuf).connect(sf);
    const flutter = c.createGain(); flutter.gain.value = 0.7;
    const fl = c.createOscillator(); fl.type = 'sawtooth'; fl.frequency.value = 7.3;
    const flG = c.createGain(); flG.gain.value = 0.3;
    fl.connect(flG); flG.connect(flutter.gain); fl.start();
    sf.connect(flutter); flutter.connect(L.storm.gain);
    this._src(this.crackleBuf).connect(L.storm.gain);
    this.loops = L;
    for (const k in this.levels) { const v = this.levels[k]; this.levels[k] = -1; this.setLoop(k, v); }
  }

  setLoop(name, level) {
    const v = level > 0 ? (level > 1 ? 1 : level) : 0;
    const prev = this.levels[name];
    if (prev === undefined) return;
    if (Math.abs(prev - v) < 0.02 && !(v === 0 && prev !== 0)) return;
    this.levels[name] = v;
    if (!this.loops || !this.ctx) return;
    const L = this.loops[name];
    const t = this.ctx.currentTime;
    const vol = AUDIO_MIX.loops[name] * (name === 'rumble' ? v * v : v);
    L.gain.gain.setTargetAtTime(vol, t, AUDIO_MIX.loopSmooth);
    if (name === 'thrust') L.filter.frequency.setTargetAtTime(420 + 1400 * v, t, 0.08);
  }

  // ------------------------------------------------------------ ambience

  setZone(key) {
    if (key === this.zone && this.music) return;
    this.zone = key;
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    if (!this.music) {
      const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 300; filter.Q.value = 3;
      const g = c.createGain(); g.gain.value = 0.0001;
      const oscs = [0, 1, 2].map((i) => {
        const o = c.createOscillator(); o.type = i === 0 ? 'sawtooth' : 'triangle';
        o.frequency.value = 55; o.detune.value = (i - 1) * 7;
        o.connect(filter); o.start();
        return o;
      });
      const lfo = c.createOscillator(); lfo.frequency.value = 0.06;
      const lfoG = c.createGain(); lfoG.gain.value = 120;
      lfo.connect(lfoG); lfoG.connect(filter.frequency); lfo.start();
      const nf = c.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 500; nf.Q.value = 0.5;
      const ng = c.createGain(); ng.gain.value = 0;
      this._src(this.noiseBuf).connect(nf); nf.connect(ng); ng.connect(this.musicBus);
      filter.connect(g); g.connect(this.musicBus);
      this.music = { oscs, g, filter, ng, nf };
    }
    const m = this.music;
    if (!key) { m.g.gain.setTargetAtTime(0.0001, t, 0.8); m.ng.gain.setTargetAtTime(0, t, 0.8); return; }
    const z = ZONES[key] || ZONES.space;
    m.oscs.forEach((o, i) => o.frequency.setTargetAtTime(z.root * Math.pow(2, z.chord[i] / 12), t, 1.5));
    m.filter.frequency.setTargetAtTime(z.cutoff, t, 1.2);
    m.g.gain.setTargetAtTime(z.vol, t, 1.5);
    m.ng.gain.setTargetAtTime(z.noise, t, 1.5);
    m.nf.frequency.setTargetAtTime(z.cutoff * 2, t, 1.5);
    this.nextBell = Math.min(this.nextBell, t + 1.5);
  }

  /** Once per frame: distant notes of the current ambience. */
  tick() {
    if (!this.ctx || this._muted || !this.zone || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now < this.nextBell) return;
    const z = ZONES[this.zone] || ZONES.space;
    this.nextBell = now + z.bell[0] + Math.random() * (z.bell[1] - z.bell[0]);
    const f = z.root * z.bellOct * Math.pow(2, PENTA[Math.floor(Math.random() * PENTA.length)] / 12);
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = z.bellType; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(this.zone === 'maelstrom' ? 0.012 : 0.022, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 4);
    o.connect(g); g.connect(this.musicBus);
    o.start(now); o.stop(now + 4.1);
  }

  update() { this.tick(); }

  // ------------------------------------------------------------ one-shots

  _env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _tone(type, f0, f1, dur, vol, a = 0.005, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this._env(g, t, a, vol, dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise(dur, vol, type, f0, f1 = 0, q = 1, a = 0.003, delay = 0, buf = null) {
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = buf || this.noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    this._env(g, t, a, vol, dur);
    s.connect(f); f.connect(g); g.connect(this.sfx);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  play(name, opts) {
    if (!this.ctx || this._muted || this.ctx.state !== 'running') return;
    const fn = SFX[name];
    if (!fn) return;
    const mat = (opts && opts.material) || '';
    const now = this.ctx.currentTime;
    const key = mat ? name + mat : name;
    if (this.last[key] && now - this.last[key] < 0.03) return;
    this.last[key] = now;
    const v = opts && opts.volume !== undefined ? opts.volume : 1;
    const p = opts && opts.pitch ? opts.pitch : 1;
    if (v <= 0.001) return;
    try { fn(this, v, p, mat); } catch (e) { if (this.debug) console.warn('audio', name, e); }
  }
}

// ------------------------------------------------------------ effect recipes: (audio, volume, pitch, material)
const SFX = {
  boost(a, v) { a._noise(0.35, 0.3 * v, 'bandpass', 500, 2400, 0.9, 0.01); a._tone('sawtooth', 90, 220, 0.25, 0.07 * v); },
  brake(a, v) { a._noise(0.18, 0.16 * v, 'highpass', 3000, 1500, 0.8); },
  deny(a, v) { a._tone('square', 220, 0, 0.08, 0.06 * v); a._tone('square', 165, 0, 0.12, 0.06 * v, 0.005, 0.09); },
  fuel_empty(a, v) { a._tone('sawtooth', 300, 70, 0.5, 0.08 * v); a._noise(0.3, 0.12 * v, 'lowpass', 800, 200); },
  bump(a, v, p, m) {
    if (m === 'rock') a._noise(0.07, 0.18 * v, 'lowpass', 700 * p, 200);
    else if (m === 'ice' || m === 'glass') a._tone('sine', 1800 * p, 0, 0.1, 0.05 * v);
    else a._tone('triangle', 260 * p, 180, 0.1, 0.1 * v);
    a._tone('sine', 80, 50, 0.08, 0.12 * v);
  },
  impact(a, v, p, m) {
    if (m === 'rock') { a._noise(0.25, 0.4 * v, 'lowpass', 1400 * p, 150); a._tone('sine', 70, 35, 0.25, 0.3 * v); }
    else if (m === 'ice') { a._noise(0.2, 0.25 * v, 'highpass', 3000, 1200); a._tone('sine', 2100 * p, 1400, 0.3, 0.08 * v); a._tone('sine', 3100 * p, 0, 0.2, 0.05 * v, 0.005, 0.03); }
    else if (m === 'glass') { a._tone('sine', 2600 * p, 0, 0.35, 0.07 * v); a._noise(0.15, 0.2 * v, 'highpass', 4000); }
    else { a._noise(0.12, 0.3 * v, 'bandpass', 1800 * p, 600, 2); a._tone('triangle', 420 * p, 190, 0.35, 0.14 * v); a._tone('sine', 65, 40, 0.2, 0.3 * v); }
  },
  hurt(a, v) { a._tone('sawtooth', 320, 110, 0.22, 0.12 * v); a._noise(0.15, 0.2 * v, 'lowpass', 1600, 300); },
  death(a, v) {
    a._noise(0.9, 0.35 * v, 'lowpass', 3000, 120, 1, 0.005);
    [196, 233, 277].forEach((f, i) => a._tone('sawtooth', f, f / 2.2, 1.4, 0.05 * v, 0.02, i * 0.07));
  },
  pickup_salvage(a, v, p) { a._tone('square', 1320 * p, 0, 0.04, 0.045 * v); a._tone('square', 1760 * p, 0, 0.08, 0.045 * v, 0.005, 0.04); },
  pickup_o2(a, v) { a._noise(0.25, 0.14 * v, 'highpass', 1500, 5000, 0.7); a._tone('sine', 660, 990, 0.15, 0.06 * v); },
  pickup_fuel(a, v) { a._tone('triangle', 330, 660, 0.14, 0.09 * v); a._noise(0.12, 0.1 * v, 'bandpass', 900, 0, 2); },
  pickup_repair(a, v) { [523, 659, 784].forEach((f, i) => a._tone('triangle', f, 0, 0.12, 0.07 * v, 0.005, i * 0.05)); },
  item(a, v) {
    [523.3, 659.3, 784, 1046.5].forEach((f, i) => a._tone('square', f, 0, 0.16, 0.06 * v, 0.005, i * 0.09));
    a._tone('triangle', 1046.5, 0, 0.9, 0.07 * v, 0.02, 0.36);
    a._tone('triangle', 1318.5, 0, 0.9, 0.05 * v, 0.02, 0.36);
    a._noise(1, 0.05 * v, 'highpass', 6000, 0, 1, 0.02, 0.36);
  },
  dock(a, v) { a._tone('sine', 440, 0, 0.12, 0.07 * v); a._tone('sine', 660, 0, 0.2, 0.07 * v, 0.005, 0.1); a._noise(0.3, 0.06 * v, 'lowpass', 400); },
  door(a, v) { a._noise(0.7, 0.2 * v, 'bandpass', 900, 300, 3, 0.02); a._tone('triangle', 150, 110, 0.6, 0.12 * v); a._noise(0.25, 0.18 * v, 'highpass', 2000, 0, 1, 0.005, 0.55); },
  crate(a, v) { a._tone('triangle', 260, 180, 0.12, 0.14 * v); a._noise(0.18, 0.2 * v, 'bandpass', 1200, 500, 2); a._tone('square', 1200, 0, 0.06, 0.04 * v, 0.005, 0.12); },
  terminal(a, v) { [880, 1175, 988, 1319].forEach((f, i) => a._tone('square', f, 0, 0.05, 0.035 * v, 0.003, i * 0.06)); },
  satellite(a, v) {
    [0, 0.15, 0.3].forEach((d) => a._tone('sine', 1760, 0, 0.08, 0.06 * v, 0.003, d));
    a._tone('sine', 400, 2400, 1.2, 0.05 * v, 0.05, 0.45);
    a._noise(1.2, 0.04 * v, 'bandpass', 800, 4000, 4, 0.05, 0.45);
  },
  refill(a, v) { a._noise(0.8, 0.16 * v, 'bandpass', 700, 2600, 1.5, 0.05); a._tone('sine', 523, 784, 0.6, 0.05 * v); },
  capsule(a, v) { a._noise(0.9, 0.25 * v, 'bandpass', 600, 150, 2, 0.02); a._tone('sine', 110, 55, 0.9, 0.2 * v); a._tone('triangle', 392, 0, 0.4, 0.06 * v, 0.01, 0.6); },
  charge_drop(a, v) { a._tone('triangle', 500, 350, 0.08, 0.1 * v); a._tone('square', 1500, 0, 0.04, 0.04 * v, 0.003, 0.08); },
  charge_beep(a, v, p) { a._tone('square', 1500 * p, 0, 0.05, 0.05 * v); },
  charge_bounce(a, v) { a._tone('triangle', 700, 500, 0.06, 0.08 * v); },
  explosion(a, v) {
    a._noise(1.3, 0.55 * v, 'lowpass', 2600, 60, 1, 0.004);
    a._tone('sine', 90, 28, 1.0, 0.45 * v);
    a._noise(0.5, 0.25 * v, 'highpass', 2500, 800, 1, 0.003, 0.02, a.crackleBuf);
  },
  rock_break(a, v, p) { a._noise(0.4, 0.35 * v, 'lowpass', 1800 * p, 120); a._tone('sine', 110 * p, 45, 0.3, 0.2 * v); },
  laser_on(a, v) { a._tone('sawtooth', 180, 1400, 0.25, 0.05 * v); a._tone('sine', 1400, 1350, 0.4, 0.04 * v, 0.01, 0.2); },
  vent(a, v) { a._noise(1.2, 0.3 * v, 'bandpass', 400, 900, 0.8, 0.05); a._noise(0.8, 0.1 * v, 'highpass', 3000, 0, 1, 0.1); },
  turret_lock(a, v) { a._tone('square', 1200, 0, 0.06, 0.05 * v); a._tone('square', 1600, 0, 0.12, 0.05 * v, 0.003, 0.08); },
  turret_fire(a, v) { a._tone('sawtooth', 900, 180, 0.2, 0.09 * v); a._noise(0.12, 0.14 * v, 'bandpass', 2000, 600, 2); },
  bolt_hit(a, v) { a._noise(0.15, 0.25 * v, 'bandpass', 1600, 400, 1.5); a._tone('square', 300, 90, 0.15, 0.08 * v); },
  turret_destroyed(a, v) { a._noise(0.6, 0.3 * v, 'lowpass', 2400, 200); [880, 660, 440, 220].forEach((f, i) => a._tone('square', f, 0, 0.07, 0.04 * v, 0.003, i * 0.07)); },
  flare_warn(a, v) { a._tone('sine', 60, 180, 1.5, 0.18 * v, 0.6); a._noise(1.5, 0.12 * v, 'bandpass', 300, 1800, 1.5, 0.8); },
  flare(a, v) { a._noise(1.4, 0.4 * v, 'lowpass', 3000, 200, 0.8, 0.01); a._tone('sawtooth', 120, 40, 1.0, 0.1 * v); },
  // ---- shell / UI
  deposit(a, v) {
    a._tone('square', 1318.5, 0, 0.08, 0.06 * v);
    a._tone('square', 1760, 0, 0.35, 0.06 * v, 0.005, 0.08);
    a._noise(0.4, 0.06 * v, 'highpass', 6000, 0, 1, 0.003, 0.08);
  },
  buy(a, v) { a._tone('square', 988, 0, 0.06, 0.06 * v); a._tone('square', 1480, 0, 0.14, 0.06 * v, 0.005, 0.06); },
  ui(a, v) { a._tone('triangle', 740, 0, 0.05, 0.07 * v); },
  ui_back(a, v) { a._tone('triangle', 520, 0, 0.05, 0.07 * v); },
  map(a, v) { a._tone('sine', 660, 880, 0.12, 0.06 * v); a._noise(0.1, 0.05 * v, 'highpass', 4000); },
  pause(a, v) { a._tone('triangle', 440, 0, 0.08, 0.07 * v); a._tone('triangle', 330, 0, 0.1, 0.07 * v, 0.005, 0.08); },
  respawn(a, v) { a._tone('sine', 220, 880, 0.6, 0.08 * v, 0.1); a._noise(0.6, 0.06 * v, 'bandpass', 500, 3000, 3, 0.1); },
  victory(a, v) {
    const seq = [392, 523.3, 659.3, 784, 659.3, 784, 1046.5];
    seq.forEach((f, i) => a._tone('triangle', f, 0, 0.3, 0.08 * v, 0.01, i * 0.16));
    a._tone('triangle', 1046.5, 0, 1.6, 0.07 * v, 0.02, seq.length * 0.16);
    a._tone('sine', 523.3, 0, 1.6, 0.06 * v, 0.02, seq.length * 0.16);
  },
  warning(a, v) { a._tone('square', 740, 0, 0.07, 0.05 * v); a._tone('square', 740, 0, 0.07, 0.05 * v, 0.003, 0.12); },
  tip(a, v) { a._tone('sine', 1175, 0, 0.08, 0.04 * v); },
  log(a, v) { [659, 784, 988].forEach((f, i) => a._tone('triangle', f, 0, 0.12, 0.05 * v, 0.005, i * 0.07)); },
};

/** Every sound name play() knows (tests, debug). */
export const SOUND_NAMES = Object.keys(SFX);
export const LOOP_NAMES = ['thrust', 'brake', 'heat', 'rumble', 'alarm', 'storm'];
export const ZONE_KEYS = Object.keys(ZONES);

export function createAudio() { return new AudioSystem(); }
