// Tiny WebAudio synth (no assets). iOS needs unlock() from a user gesture.

const SOUNDS = {
  jump: { type: 'square', f: [220, 440], d: 0.12, v: 0.08 },
  grip: { type: 'triangle', f: [180, 140], d: 0.06, v: 0.1 },
  slip: { type: 'sawtooth', f: [300, 90], d: 0.3, v: 0.06 },
  bite: { type: 'square', f: [140, 70], d: 0.08, v: 0.1 },
  hit: { type: 'square', f: [320, 120], d: 0.1, v: 0.1 },
  kill: { type: 'sawtooth', f: [260, 40], d: 0.35, v: 0.1 },
  hurt: { type: 'sawtooth', f: [200, 80], d: 0.2, v: 0.12 },
  eat: { type: 'triangle', f: [500, 700], d: 0.12, v: 0.1 },
  harvest: { type: 'triangle', f: [300, 600], d: 0.15, v: 0.1 },
  collect: { type: 'triangle', f: [660, 990], d: 0.12, v: 0.08 },
  tame: { type: 'triangle', f: [440, 880], d: 0.35, v: 0.1 },
  build: { type: 'square', f: [120, 240], d: 0.16, v: 0.08 },
  deny: { type: 'square', f: [140, 110], d: 0.14, v: 0.07 },
  cook: { type: 'sawtooth', f: [90, 160], d: 0.4, v: 0.05 },
  splash: { type: 'triangle', f: [400, 150], d: 0.2, v: 0.08 },
  rest: { type: 'triangle', f: [330, 495], d: 0.5, v: 0.08 },
  death: { type: 'sawtooth', f: [300, 30], d: 1, v: 0.12 },
};

export class Audio {
  constructor({ muted = false } = {}) {
    this.ctx = null;
    this.muted = muted;
    this.last = {};
  }

  unlock() {
    if (this.ctx || this.muted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch { this.ctx = null; }
  }

  play(name) {
    const s = SOUNDS[name];
    if (!s || !this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    if (this.last[name] && now - this.last[name] < 0.05) return;
    this.last[name] = now;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = s.type;
      o.frequency.setValueAtTime(s.f[0], now);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, s.f[1]), now + s.d);
      g.gain.setValueAtTime(s.v, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + s.d);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(now); o.stop(now + s.d + 0.02);
    } catch { /* audio is optional */ }
  }
}

/** Silent stand-in for tests. */
export const silentAudio = { play() {}, unlock() {} };
