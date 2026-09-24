// Synthesized WebAudio sound effects + a quiet procedural ambience per layer.
// No audio files. The AudioContext is created/resumed on the first user gesture (iOS).
//
// API: audio.play(name, opts) ; audio.setMuted(b) ; audio.toggleMute() ; audio.unlock()
//      audio.setLayer(index) ; audio.suspend() / audio.resume()
// Sounds: jump land swing hit(material) break(material) clink pickup hurt enemy_hit
//         enemy_death grapple_fire grapple_attach grapple_release bank death buy ui lava chest
import { MUTE_KEY } from './config.js';

const LAYER_ROOTS = [55, 49, 46.25, 41.2, 36.7]; // A1, G1, F#1, E1, D1
const PENTA = [0, 3, 5, 7, 10, 12, 15];

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.unlocked = false;
    this.last = {};
    this.layer = -1;
    this.music = null;
    this.nextBell = 0;
    try { this.muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage blocked */ }
  }

  /** Create / resume the context. Must run inside a user gesture on iOS. */
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.8;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 4;
        this.master.connect(comp); comp.connect(this.ctx.destination);
        this.sfx = this.ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
        this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = 0.5; this.musicBus.connect(this.master);
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        let seed = 12345;
        for (let i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = (seed / 4294967296) * 2 - 1; }
      }
      this._wake();
      if (!this.unlocked) {
        // silent blip completes the iOS unlock
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
        this.unlocked = true;
      }
    } catch { /* audio unavailable: stay silent */ }
  }

  suspend() {
    try { if (this.ctx && this.ctx.state === 'running') { const r = this.ctx.suspend(); if (r && r.catch) r.catch(() => {}); } } catch { /* ignore */ }
  }
  resume() { try { this._wake(); } catch { /* ignore */ } }

  /**
   * Resume the context from any non-running state: 'suspended', and WebKit's
   * iOS-only 'interrupted' (phone call, Siri, alarm), which never auto-resumes
   * reliably. The promise can reject outside a user gesture: swallow it, the
   * next touch (onAnyInput -> unlock) tries again.
   */
  _wake() {
    const c = this.ctx;
    if (!c || c.state === 'running' || c.state === 'closed') return;
    const r = c.resume();
    if (r && r.catch) r.catch(() => {});
  }

  setMuted(b) {
    this.muted = !!b;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* ignore */ }
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.03);
  }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  // ------------------------------------------------------------ synthesis helpers
  _env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _tone({ type = 'square', f0 = 440, f1 = null, dur = 0.1, vol = 0.2, a = 0.005, delay = 0, pan = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this._env(g, t, a, vol, dur);
    this._out(o, g, pan);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise({ dur = 0.1, vol = 0.2, type = 'lowpass', f0 = 1000, f1 = null, q = 1, a = 0.003, delay = 0, pan = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    this._env(g, t, a, vol, dur);
    s.connect(f);
    this._out(f, g, pan);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  _out(node, gain, pan) {
    node.connect(gain);
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(p); p.connect(this.sfx);
    } else gain.connect(this.sfx);
  }

  /**
   * Play a named effect. opts: { volume (0..1), pitch (multiplier), material, pan }
   * Rapid repeats of the same sound are throttled.
   */
  play(name, opts = {}) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const key = name + (opts.material || '');
    if (this.last[key] && now - this.last[key] < 0.03) return;
    this.last[key] = now;
    const fn = SFX[name];
    if (!fn) return;
    try { fn(this, opts.volume ?? 1, opts.pitch ?? 1, opts); } catch (e) { if (this.debug) console.warn('audio', name, e); /* never let audio break the game */ }
  }

  // ------------------------------------------------------------ ambience
  setLayer(index) {
    if (!this.ctx || index === this.layer) return;
    this.layer = index;
    const root = LAYER_ROOTS[Math.max(0, Math.min(LAYER_ROOTS.length - 1, index))];
    const c = this.ctx, t = c.currentTime;
    if (!this.music) {
      const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 320; filter.Q.value = 3;
      const g = c.createGain(); g.gain.value = 0.0001;
      const oscs = [0, 7.02, 12.01].map((semi, i) => {
        const o = c.createOscillator(); o.type = i === 0 ? 'sawtooth' : 'triangle';
        o.frequency.value = root * Math.pow(2, semi / 12);
        o.detune.value = (i - 1) * 6;
        o.connect(filter); o.start();
        return { o, semi };
      });
      const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
      const lfoG = c.createGain(); lfoG.gain.value = 140;
      lfo.connect(lfoG); lfoG.connect(filter.frequency); lfo.start();
      filter.connect(g); g.connect(this.musicBus);
      g.gain.exponentialRampToValueAtTime(0.05, t + 4);
      this.music = { oscs, g, filter };
    } else {
      for (const { o, semi } of this.music.oscs) o.frequency.setTargetAtTime(root * Math.pow(2, semi / 12), t, 1.5);
    }
  }

  /** Called every frame while playing: occasional distant bell notes. */
  update() {
    if (!this.ctx || this.muted || this.layer < 0 || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now < this.nextBell) return;
    this.nextBell = now + 4 + Math.random() * 6;
    const root = LAYER_ROOTS[Math.min(LAYER_ROOTS.length - 1, this.layer)] * 8;
    const f = root * Math.pow(2, PENTA[Math.floor(Math.random() * PENTA.length)] / 12);
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.025, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    o.connect(g); g.connect(this.musicBus);
    o.start(t); o.stop(t + 3.6);
  }
}

// ------------------------------------------------------------ effect recipes
const SFX = {
  jump(a, v, p) { a._tone({ type: 'square', f0: 180 * p, f1: 420 * p, dur: 0.1, vol: 0.07 * v }); },
  land(a, v) { a._noise({ dur: 0.08, vol: 0.2 * v, f0: 500, f1: 120 }); a._tone({ type: 'sine', f0: 90, f1: 50, dur: 0.08, vol: 0.15 * v }); },
  swing(a, v) { a._noise({ dur: 0.09, vol: 0.09 * v, type: 'bandpass', f0: 900, f1: 2600, q: 1.2 }); },
  hit(a, v, p, o) {
    const m = o.material || 'stone';
    if (m === 'soft') { a._noise({ dur: 0.07, vol: 0.28 * v, f0: 700 * p, f1: 200 }); a._tone({ type: 'sine', f0: 110 * p, f1: 60, dur: 0.07, vol: 0.16 * v }); }
    else if (m === 'metal') { a._noise({ dur: 0.05, vol: 0.18 * v, type: 'bandpass', f0: 2600 * p, q: 3 }); a._tone({ type: 'triangle', f0: 740 * p, f1: 520 * p, dur: 0.12, vol: 0.1 * v }); }
    else if (m === 'crystal') { a._tone({ type: 'sine', f0: 1480 * p, dur: 0.22, vol: 0.08 * v }); a._tone({ type: 'sine', f0: 2220 * p, dur: 0.16, vol: 0.05 * v }); a._noise({ dur: 0.04, vol: 0.12 * v, type: 'highpass', f0: 3000 }); }
    else if (m === 'bone') { a._noise({ dur: 0.05, vol: 0.22 * v, type: 'bandpass', f0: 1300 * p, q: 4 }); }
    else if (m === 'wood') { a._tone({ type: 'triangle', f0: 240 * p, f1: 160, dur: 0.08, vol: 0.18 * v }); a._noise({ dur: 0.04, vol: 0.1 * v, type: 'bandpass', f0: 900 }); }
    else { a._noise({ dur: 0.06, vol: 0.22 * v, type: 'bandpass', f0: 1700 * p, q: 1.5 }); a._tone({ type: 'triangle', f0: 320 * p, f1: 170, dur: 0.07, vol: 0.12 * v }); }
  },
  break(a, v, p, o) {
    const m = o.material || 'stone';
    const f = m === 'soft' ? 900 : m === 'crystal' ? 3200 : m === 'metal' ? 2400 : 1600;
    a._noise({ dur: 0.22, vol: 0.3 * v, f0: f * p, f1: 150 });
    a._tone({ type: 'sine', f0: 80, f1: 40, dur: 0.16, vol: 0.2 * v });
    if (m === 'crystal') { a._tone({ type: 'sine', f0: 1760 * p, dur: 0.35, vol: 0.07 * v }); a._tone({ type: 'sine', f0: 2637 * p, dur: 0.3, vol: 0.05 * v, delay: 0.04 }); }
    if (m === 'metal') a._tone({ type: 'triangle', f0: 990 * p, dur: 0.2, vol: 0.07 * v });
  },
  clink(a, v) { a._tone({ type: 'triangle', f0: 1900, dur: 0.18, vol: 0.12 * v }); a._tone({ type: 'sine', f0: 2850, dur: 0.14, vol: 0.07 * v }); a._noise({ dur: 0.03, vol: 0.15 * v, type: 'highpass', f0: 4000 }); },
  pickup(a, v, p) { a._tone({ type: 'square', f0: 880 * p, dur: 0.05, vol: 0.06 * v }); a._tone({ type: 'square', f0: 1320 * p, dur: 0.08, vol: 0.06 * v, delay: 0.05 }); },
  hurt(a, v) { a._tone({ type: 'sawtooth', f0: 320, f1: 110, dur: 0.22, vol: 0.13 * v }); a._noise({ dur: 0.12, vol: 0.2 * v, f0: 1500, f1: 300 }); },
  enemy_hit(a, v, p) { a._noise({ dur: 0.07, vol: 0.2 * v, type: 'bandpass', f0: 1100 * p, q: 2 }); a._tone({ type: 'square', f0: 260 * p, f1: 140, dur: 0.07, vol: 0.07 * v }); },
  enemy_death(a, v, p) { a._noise({ dur: 0.3, vol: 0.24 * v, f0: 2000, f1: 200 }); a._tone({ type: 'square', f0: 420 * p, f1: 60, dur: 0.3, vol: 0.08 * v }); },
  grapple_fire(a, v) { a._tone({ type: 'sawtooth', f0: 260, f1: 1100, dur: 0.12, vol: 0.05 * v }); a._noise({ dur: 0.12, vol: 0.1 * v, type: 'bandpass', f0: 1800, f1: 3500, q: 2 }); },
  grapple_attach(a, v) { a._tone({ type: 'triangle', f0: 1100, f1: 700, dur: 0.07, vol: 0.14 * v }); a._noise({ dur: 0.04, vol: 0.2 * v, type: 'bandpass', f0: 2500, q: 3 }); },
  grapple_release(a, v) { a._tone({ type: 'sine', f0: 700, f1: 320, dur: 0.07, vol: 0.06 * v }); },
  bank(a, v) {
    a._tone({ type: 'square', f0: 1318.5, dur: 0.09, vol: 0.07 * v });
    a._tone({ type: 'square', f0: 1760, dur: 0.35, vol: 0.07 * v, delay: 0.08 });
    a._noise({ dur: 0.4, vol: 0.06 * v, type: 'highpass', f0: 6000, delay: 0.08 });
  },
  death(a, v) {
    [220, 261.6, 311.1].forEach((f, i) => a._tone({ type: 'sawtooth', f0: f, f1: f / 2, dur: 1.3, vol: 0.06 * v, a: 0.02, delay: i * 0.06 }));
    a._noise({ dur: 0.6, vol: 0.2 * v, f0: 800, f1: 80 });
  },
  buy(a, v) { a._tone({ type: 'square', f0: 988, dur: 0.06, vol: 0.06 * v }); a._tone({ type: 'square', f0: 1480, dur: 0.14, vol: 0.06 * v, delay: 0.06 }); },
  ui(a, v) { a._tone({ type: 'triangle', f0: 660, dur: 0.05, vol: 0.08 * v }); },
  lava(a, v) { a._noise({ dur: 0.35, vol: 0.22 * v, type: 'bandpass', f0: 3000, f1: 800, q: 0.8 }); },
  chest(a, v) { a._tone({ type: 'triangle', f0: 523, dur: 0.1, vol: 0.1 * v }); a._tone({ type: 'triangle', f0: 659, dur: 0.1, vol: 0.1 * v, delay: 0.1 }); a._tone({ type: 'triangle', f0: 784, dur: 0.3, vol: 0.1 * v, delay: 0.2 }); },
};

export function createAudio() { return new AudioSystem(); }
