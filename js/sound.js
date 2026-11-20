// Synthesised sound effects (Web Audio) — no audio files needed.
export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.7;
    this._last = {};
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  unlock() { this._ensure(); }

  _noise(t, { dur = 0.06, type = 'bandpass', freq = 1200, q = 1, gain = 0.5, attack = 0.002 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  _tone(t, { freq = 440, to = null, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.005 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _knock(t, s = 1) {
    this._noise(t, { dur: 0.07 * s, freq: 900 + Math.random() * 300, q: 1.4, gain: 0.55 * s });
    this._noise(t, { dur: 0.025, type: 'highpass', freq: 3200, q: 0.7, gain: 0.12 * s });
    this._tone(t, { freq: 190 + Math.random() * 20, to: 95, dur: 0.09 * s, gain: 0.35 * s });
  }

  play(name) {
    if (!this.enabled || this.volume <= 0) return;
    const ctx = this._ensure();
    if (!ctx) return;
    // throttle identical sounds fired in the same instant
    const now = performance.now();
    if (this._last[name] && now - this._last[name] < 40) return;
    this._last[name] = now;
    this.master.gain.value = this.volume;
    const t = ctx.currentTime + 0.005;
    switch (name) {
      case 'move': this._knock(t, 1); break;
      case 'capture':
        this._knock(t, 1.25);
        this._knock(t + 0.03, 0.8);
        this._noise(t, { dur: 0.05, type: 'highpass', freq: 2500, gain: 0.25 });
        break;
      case 'castle': this._knock(t, 0.95); this._knock(t + 0.13, 0.9); break;
      case 'tray': this._knock(t, 0.45); break;
      case 'thud':
        this._noise(t, { dur: 0.16, type: 'lowpass', freq: 600, q: 0.8, gain: 0.7 });
        this._tone(t, { freq: 120, to: 55, dur: 0.22, gain: 0.5 });
        break;
      case 'pick': this._noise(t, { dur: 0.02, type: 'highpass', freq: 3000, gain: 0.08 }); break;
      case 'illegal': this._tone(t, { freq: 160, to: 120, dur: 0.12, type: 'triangle', gain: 0.15 }); break;
      case 'check':
        this._tone(t, { freq: 988, dur: 0.35, type: 'sine', gain: 0.22 });
        this._tone(t, { freq: 1480, dur: 0.25, type: 'sine', gain: 0.08 });
        this._tone(t + 0.09, { freq: 1318, dur: 0.4, type: 'sine', gain: 0.16 });
        break;
      case 'promote':
        [1047, 1319, 1568, 2093].forEach((f, i) => this._tone(t + i * 0.06, { freq: f, dur: 0.3, type: 'triangle', gain: 0.13 }));
        break;
      case 'start':
        this._tone(t, { freq: 784, dur: 0.25, type: 'triangle', gain: 0.18 });
        this._tone(t + 0.14, { freq: 1047, dur: 0.45, type: 'triangle', gain: 0.18 });
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this._tone(t + i * 0.11, { freq: f, dur: 0.5, type: 'triangle', gain: 0.17 }));
        this._tone(t + 0.44, { freq: 1568, dur: 0.7, type: 'sine', gain: 0.08 });
        break;
      case 'lose':
        [440, 370, 294].forEach((f, i) => this._tone(t + i * 0.16, { freq: f, dur: 0.5, type: 'triangle', gain: 0.15 }));
        break;
      case 'draw':
        this._tone(t, { freq: 659, dur: 0.45, type: 'triangle', gain: 0.14 });
        this._tone(t + 0.15, { freq: 659, dur: 0.5, type: 'triangle', gain: 0.12 });
        break;
      case 'notify':
        this._tone(t, { freq: 660, to: 990, dur: 0.12, gain: 0.12 });
        break;
      case 'chat':
        this._tone(t, { freq: 880, dur: 0.08, gain: 0.07 });
        break;
      case 'join':
        this._tone(t, { freq: 587, dur: 0.12, type: 'triangle', gain: 0.12 });
        this._tone(t + 0.09, { freq: 880, dur: 0.18, type: 'triangle', gain: 0.12 });
        break;
      case 'leave':
        this._tone(t, { freq: 784, dur: 0.12, type: 'triangle', gain: 0.1 });
        this._tone(t + 0.09, { freq: 523, dur: 0.18, type: 'triangle', gain: 0.1 });
        break;
      case 'tick': this._noise(t, { dur: 0.018, type: 'highpass', freq: 4000, gain: 0.12 }); break;
      case 'emote': this._tone(t, { freq: 520, to: 1040, dur: 0.1, gain: 0.1 }); break;
      case 'ready': this._tone(t, { freq: 1046, dur: 0.12, type: 'sine', gain: 0.12 }); break;
      default: break;
    }
  }
}
