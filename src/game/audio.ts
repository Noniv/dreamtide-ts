// Dreamtide audio: every sound synthesized from oscillators & noise. No assets.

interface ToneOpts {
  type?: OscillatorType; freq?: number; to?: number | null;
  a?: number; d?: number; peak?: number; glideTime?: number; pan?: number;
}
interface NoiseOpts {
  dur?: number; peak?: number; freq?: number; q?: number;
  type?: BiquadFilterType; slideTo?: number | null;
}

class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  sfxBus: GainNode | null = null;
  padBus: GainNode | null = null;
  enabled = true;
  lastPlay: Record<string, number> = {};
  padStarted = false;
  // player-set volumes (0..1), multiplied onto each bus's baseline gain
  musicVol = 0.7;
  sfxVol = 0.9;
  private padBase = 0.5; // pad's own ramped-in level, before musicVol scaling

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.sfxVol;
    this.sfxBus.connect(this.master);

    this.padBus = this.ctx.createGain();
    this.padBus.gain.value = 0.0;
    this.padBus.connect(this.master);
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this.startPad();
  }

  // Ambient dream drone: detuned sines drifting through a slow filter.
  startPad() {
    if (!this.ctx || this.padStarted) return;
    this.padStarted = true;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.connect(this.padBus!);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 320;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    [55, 82.4, 110, 164.8, 220.0].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 14;
      const g = ctx.createGain();
      g.gain.value = i < 2 ? 0.055 : 0.03;
      o.connect(g);
      g.connect(filter);
      o.start();
      const vLfo = ctx.createOscillator();
      vLfo.frequency.value = 0.03 + Math.random() * 0.05;
      const vG = ctx.createGain();
      vG.gain.value = 4 + Math.random() * 5;
      vLfo.connect(vG);
      vG.connect(o.detune);
      vLfo.start();
    });
    this.padBus!.gain.setValueAtTime(0, t);
    this.padBus!.gain.linearRampToValueAtTime(this.padBase * this.musicVol, t + 6);
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? 0.55 : 0;
  }

  // Music = the ambient dream pad. 0 silences it; changes apply immediately.
  setMusicVolume(v: number) {
    this.musicVol = Math.max(0, Math.min(1, v));
    if (this.padBus && this.ctx) {
      this.padBus.gain.cancelScheduledValues(this.ctx.currentTime);
      this.padBus.gain.setValueAtTime(this.padBase * this.musicVol, this.ctx.currentTime);
    }
  }

  // Sounds = every synthesized cue (casts, hits, pickups).
  setSfxVolume(v: number) {
    this.sfxVol = Math.max(0, Math.min(1, v));
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxVol;
  }

  throttled(key: string, minGap: number): boolean {
    const now = performance.now();
    if (this.lastPlay[key] && now - this.lastPlay[key] < minGap) return true;
    this.lastPlay[key] = now;
    return false;
  }

  env(gainNode: GainNode, t: number, a: number, peak: number, d: number, sustain = 0.0001) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.exponentialRampToValueAtTime(sustain, t + a + d);
  }

  tone({ type = 'sine', freq = 440, to = null, a = 0.005, d = 0.2, peak = 0.2, glideTime = 0.1, pan = 0 }: ToneOpts) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + glideTime);
    const g = this.ctx.createGain();
    this.env(g, t, a, peak, d);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    o.connect(g);
    if (p) {
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.sfxBus!);
    } else g.connect(this.sfxBus!);
    o.start(t);
    o.stop(t + a + d + 0.05);
  }

  noise({ dur = 0.3, peak = 0.2, freq = 1200, q = 1, type = 'bandpass', slideTo = null }: NoiseOpts) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 30), t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, peak, dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus!);
    src.start(t);
  }

  // ---- named cues ----
  fireCast() {
    if (this.throttled('fire', 70)) return;
    this.noise({ dur: 0.18, peak: 0.11, freq: 900, slideTo: 300, q: 0.8 });
    this.tone({ type: 'triangle', freq: 220, to: 90, d: 0.16, peak: 0.09 });
  }
  fireBoom() {
    if (this.throttled('boom', 60)) return;
    this.noise({ dur: 0.4, peak: 0.2, freq: 500, slideTo: 90, q: 0.7, type: 'lowpass' });
    this.tone({ type: 'sine', freq: 130, to: 45, d: 0.35, peak: 0.22, glideTime: 0.3 });
  }
  frostCast() {
    if (this.throttled('frost', 120)) return;
    this.tone({ type: 'sine', freq: 1400, to: 2600, d: 0.25, peak: 0.06, glideTime: 0.22 });
    this.noise({ dur: 0.35, peak: 0.07, freq: 5200, q: 2.5 });
  }
  arcaneCast(pan = 0) {
    if (this.throttled('arcane', 55)) return;
    const f = 620 + Math.random() * 240;
    this.tone({ type: 'square', freq: f, to: f * 1.9, d: 0.09, peak: 0.035, glideTime: 0.07, pan });
  }
  stormCast() {
    if (this.throttled('storm', 90)) return;
    this.noise({ dur: 0.14, peak: 0.16, freq: 3000, slideTo: 700, q: 0.6 });
    this.tone({ type: 'sawtooth', freq: 90, to: 55, d: 0.1, peak: 0.07 });
  }
  voidCast() {
    if (this.throttled('void', 200)) return;
    this.tone({ type: 'sine', freq: 200, to: 40, d: 0.8, peak: 0.13, glideTime: 0.75 });
    this.tone({ type: 'sine', freq: 205, to: 42, d: 0.8, peak: 0.1, glideTime: 0.75 });
  }
  beamHum() {
    if (this.throttled('beam', 260)) return;
    this.tone({ type: 'sawtooth', freq: 160, to: 210, d: 0.24, peak: 0.035, glideTime: 0.22 });
    this.tone({ type: 'sine', freq: 640, to: 840, d: 0.24, peak: 0.03, glideTime: 0.22 });
  }
  petalTick() {
    if (this.throttled('petal', 140)) return;
    this.tone({ type: 'triangle', freq: 980 + Math.random() * 260, to: 620, d: 0.06, peak: 0.03 });
  }
  starfallCast() {
    if (this.throttled('starfall', 150)) return;
    this.tone({ type: 'sine', freq: 1800, to: 500, d: 0.4, peak: 0.05, glideTime: 0.38 });
  }
  fangCast() {
    if (this.throttled('fang', 80)) return;
    this.noise({ dur: 0.12, peak: 0.09, freq: 700, slideTo: 220, q: 1.4 });
    this.tone({ type: 'sawtooth', freq: 140, to: 60, d: 0.12, peak: 0.05 });
  }
  glaiveCast() {
    if (this.throttled('glaive', 140)) return;
    this.tone({ type: 'triangle', freq: 520, to: 1500, d: 0.2, peak: 0.06, glideTime: 0.18 });
    this.noise({ dur: 0.16, peak: 0.05, freq: 3600, q: 3 });
  }
  nebulaCast() {
    if (this.throttled('nebula', 300)) return;
    this.tone({ type: 'sine', freq: 300, to: 480, d: 0.9, peak: 0.08, glideTime: 0.8 });
    this.tone({ type: 'sine', freq: 452, to: 720, d: 0.9, peak: 0.05, glideTime: 0.8 });
  }
  sigilBoom() {
    if (this.throttled('sigil', 160)) return;
    this.tone({ type: 'triangle', freq: 660, to: 220, d: 0.3, peak: 0.1, glideTime: 0.25 });
    this.noise({ dur: 0.3, peak: 0.1, freq: 900, slideTo: 200, q: 0.9 });
  }
  lanternCast() {
    if (this.throttled('lantern', 110)) return;
    const f = 840 + Math.random() * 180;
    this.tone({ type: 'sine', freq: f, to: f * 0.6, d: 0.18, peak: 0.04, glideTime: 0.15 });
  }
  novaCast() {
    if (this.throttled('nova', 220)) return;
    this.noise({ dur: 0.35, peak: 0.14, freq: 600, slideTo: 140, q: 0.8, type: 'lowpass' });
    this.tone({ type: 'sine', freq: 220, to: 70, d: 0.4, peak: 0.12, glideTime: 0.35 });
  }
  enemyShot() {
    if (this.throttled('eshot', 180)) return;
    this.tone({ type: 'square', freq: 340, to: 190, d: 0.1, peak: 0.03, glideTime: 0.08 });
  }
  hit() {
    if (this.throttled('hit', 45)) return;
    this.noise({ dur: 0.07, peak: 0.07, freq: 1800, q: 1.2 });
  }
  hurt() {
    if (this.throttled('hurt', 220)) return;
    this.tone({ type: 'sawtooth', freq: 190, to: 70, d: 0.22, peak: 0.16 });
    this.noise({ dur: 0.18, peak: 0.1, freq: 400, slideTo: 120 });
  }
  gem() {
    if (this.throttled('gem', 50)) return;
    const base = 720 + Math.random() * 160;
    this.tone({ type: 'sine', freq: base, to: base * 1.5, d: 0.1, peak: 0.05, glideTime: 0.08 });
  }
  levelUp() {
    if (!this.ctx || !this.enabled) return;
    // collapse back-to-back calls (a multi-level gem opens several choices in
    // quick succession) into one arpeggio — overlapping ones sound muddy
    if (this.throttled('levelUp', 600)) return;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      setTimeout(() => {
        this.tone({ type: 'triangle', freq: f, d: 0.5, peak: 0.12 });
        this.tone({ type: 'sine', freq: f / 2, d: 0.5, peak: 0.07 });
      }, i * 85);
    });
  }
  choose() {
    this.tone({ type: 'triangle', freq: 880, to: 1320, d: 0.18, peak: 0.09, glideTime: 0.12 });
  }
  bossRoar() {
    if (!this.ctx || !this.enabled) return;
    this.tone({ type: 'sawtooth', freq: 70, to: 34, d: 1.4, peak: 0.2, glideTime: 1.2 });
    this.noise({ dur: 1.2, peak: 0.12, freq: 220, slideTo: 60, type: 'lowpass' });
  }
  death() {
    if (!this.ctx || !this.enabled) return;
    [392, 311, 233, 155, 98].forEach((f, i) => {
      setTimeout(() => this.tone({ type: 'triangle', freq: f, to: f * 0.7, d: 0.7, peak: 0.12, glideTime: 0.6 }), i * 190);
    });
  }
}

export const audio = new AudioEngine();
