// Dreamtide audio — every sound synthesized live from oscillators and noise;
// no assets. The whole soundscape shares one tonal palette (A major
// pentatonic, rooted on the pad's A drone) so casts, kills, pickups and music
// are always consonant with each other, and threat is expressed by *leaving*
// the palette (minor thirds, semitone clusters) rather than by volume.
//
// Architecture:
//   one-shots → sfx/ui bus → duck gain → master → limiter → out
//   pad + music layers → music bus → duck → dim → master
//   every cue can tap a shared procedural reverb (2.4 s dream tail)
//
// Systems: adaptive music (intensity opens the pad's filter, boss presence
// darkens the chord, low HP adds a heartbeat), per-cue cooldowns, repeat-decay
// auto-gain so spammy cues fade instead of fatiguing, voice-count priority
// caps, micro pitch/level variation on everything, and an XP-gem combo ladder
// that climbs the scale while you keep collecting.

type Bus = 'sfx' | 'ui' | 'music';

interface ToneOpts {
  freq: number; type?: OscillatorType;
  to?: number; glide?: number;         // pitch ramp target + time
  a?: number; d: number; peak: number; // envelope
  at?: number;                         // start offset on the audio clock
  pan?: number; detune?: number;       // cents
  filter?: BiquadFilterType; ff?: number; fto?: number; q?: number;
  verb?: number;                       // reverb send 0..1
  bus?: Bus; pri?: number;
}

interface NoiseOpts {
  dur: number; a?: number; peak: number;
  freq?: number; to?: number; q?: number; type?: BiquadFilterType;
  at?: number; pan?: number; verb?: number; bus?: Bus; pri?: number;
}

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- palette
// Semitones above A2 (110 Hz). The pad drones A, so anything drawn from the
// A major pentatonic scale (A B C# E F#) always lands consonant.
const nt = (semi: number) => 110 * Math.pow(2, semi / 12);
const PENT = [0, 2, 4, 7, 9];
// degree 0 = A2, degree 5 = A3, degree 10 = A4 …
const pent = (deg: number) => nt(Math.floor(deg / 5) * 12 + PENT[((deg % 5) + 5) % 5]);
// ±amt proportional micro-variation, applied to nearly every freq/peak
const vary = (v: number, amt = 0.03) => v * (1 + (Math.random() * 2 - 1) * amt);

class AudioEngine {
  ctx: AudioContext | null = null;
  enabled = true;
  // player-set volumes (0..1); App seeds these before the context opens
  musicVol = 0.7;
  sfxVol = 0.9;

  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private duckSfx: GainNode | null = null;
  private duckMusic: GainNode | null = null;
  private dimMusic: GainNode | null = null; // sustained dim (death screen)
  private revIn: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  // one-shot bookkeeping
  private active = 0; // live one-shot voices, for priority caps
  private lastPlay: Record<string, number> = {};
  private busyMap: Record<string, { n: number; t: number }> = {};

  // xp gem combo ladder
  private gemDeg = 0;
  private lastGem = 0;

  // adaptive music state
  private musicStarted = false;
  private padFilter: BiquadFilterNode | null = null;
  private padLevel: GainNode | null = null;
  private oscThird: OscillatorNode | null = null;  // C#4 ↔ C4 (major ↔ minor)
  private oscColor: OscillatorNode | null = null;  // B3 ↔ G3 (add9 ↔ m7)
  private mIntensity = 0.15; private tIntensity = 0.15; // smoothed / target
  private mDanger = 0; private tDanger = 0;
  private darkness = 0; private boss = false;
  private nextChime = 0; private nextBeat = 0; private nextPulse = 0;
  private pulseAlt = false;
  private tickTimer: number | null = null;

  // ---------------------------------------------------------------- setup
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    // master → limiter → out. The limiter is tuned as a brickwall so a chaotic
    // endgame frame can stack dozens of voices without clipping.
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    // buses: dedicated duck gains let big moments push the wash down
    this.duckSfx = ctx.createGain();
    this.duckSfx.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVol;
    this.sfxBus.connect(this.duckSfx);

    this.uiBus = ctx.createGain();
    this.uiBus.gain.value = this.sfxVol * 0.85;
    this.uiBus.connect(this.master);

    this.dimMusic = ctx.createGain();
    this.dimMusic.connect(this.master);
    this.duckMusic = ctx.createGain();
    this.duckMusic.connect(this.dimMusic);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVol;
    this.musicBus.connect(this.duckMusic);

    // shared white-noise source material — one allocation for the whole game
    const nLen = (2 * ctx.sampleRate) | 0;
    this.noiseBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;

    // procedural reverb: a 2.4 s exponentially-decaying noise IR that darkens
    // as it fades — the "dream space" every magical cue hangs in
    const rDur = 2.4, rate = ctx.sampleRate, rLen = (rDur * rate) | 0;
    const ir = ctx.createBuffer(2, rLen, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < rLen; i++) {
        const t = i / rate;
        const e = Math.exp(-3.0 * t);
        const k = 0.22 + 0.5 * e; // one-pole lowpass closes as the tail decays
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = t < 0.028 ? 0 : lp * e * 0.62;
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.revIn = ctx.createGain();
    this.revIn.gain.value = 1;
    this.revIn.connect(conv);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.85;
    conv.connect(revOut);
    revOut.connect(this.master);
  }

  // Call from any user gesture: opens the context and starts the ambient music
  // (so the main menu already breathes). Safe to call every click.
  resume() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.startMusic();
  }
  userGesture() { this.resume(); }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v ? 0.8 : 0, this.ctx.currentTime, 0.03);
  }

  setMusicVolume(v: number) {
    this.musicVol = clamp(v, 0, 1);
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.05);
  }

  setSfxVolume(v: number) {
    this.sfxVol = clamp(v, 0, 1);
    if (this.sfxBus && this.ctx) {
      this.sfxBus.gain.setTargetAtTime(this.sfxVol, this.ctx.currentTime, 0.05);
      this.uiBus!.gain.setTargetAtTime(this.sfxVol * 0.85, this.ctx.currentTime, 0.05);
    }
  }

  // ------------------------------------------------------------- utilities
  private ready() { return !!this.ctx && this.enabled; }

  // per-cue minimum gap between triggers
  private throttled(key: string, minGap: number): boolean {
    const now = performance.now();
    if (this.lastPlay[key] && now - this.lastPlay[key] < minGap) return true;
    this.lastPlay[key] = now;
    return false;
  }

  // anti-fatigue auto-gain: rapid repeats of the same cue decay toward a
  // whisper (never silent) and recover with the given half-life
  private busy(key: string, halfLife = 700): number {
    const now = performance.now();
    const b = this.busyMap[key] || (this.busyMap[key] = { n: 0, t: now });
    b.n *= Math.pow(0.5, (now - b.t) / halfLife);
    b.t = now;
    b.n += 1;
    return Math.max(0.3, 1 / (1 + 0.33 * (b.n - 1)));
  }

  // voice-count priority gate: under pressure only the important cues speak
  private allow(pri: number): boolean {
    if (this.active > 56) return pri >= 3;
    if (this.active > 40) return pri >= 2;
    if (this.active > 26) return pri >= 1;
    return true;
  }

  private busNode(bus?: Bus): GainNode {
    return bus === 'ui' ? this.uiBus! : bus === 'music' ? this.musicBus! : this.sfxBus!;
  }

  private busVol(bus?: Bus): number {
    return bus === 'music' ? this.musicVol : this.sfxVol;
  }

  private env(p: AudioParam, t0: number, a: number, peak: number, d: number) {
    p.setValueAtTime(0.0001, t0);
    if (a > 0.003) p.linearRampToValueAtTime(peak, t0 + a);
    else p.exponentialRampToValueAtTime(peak, t0 + Math.max(a, 0.0015));
    p.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  // route env-gain → (panner) → bus, with an optional post-envelope reverb tap
  private route(g: GainNode, opts: { pan?: number; verb?: number; bus?: Bus }) {
    const ctx = this.ctx!;
    let head: AudioNode = g;
    if (opts.pan) {
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { p.pan.value = clamp(opts.pan, -1, 1); g.connect(p); head = p; }
    }
    head.connect(this.busNode(opts.bus));
    if (opts.verb && this.revIn) {
      const s = ctx.createGain();
      // capture the bus volume at trigger time so the wet level follows it
      s.gain.value = opts.verb * this.busVol(opts.bus);
      g.connect(s);
      s.connect(this.revIn);
    }
  }

  private tone(o: ToneOpts) {
    if (!this.ready()) return;
    const pri = o.pri ?? 1;
    if (!this.allow(pri)) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.at || 0);
    const a = o.a ?? 0.004;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(o.freq, 20), t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(o.to, 20), t0 + (o.glide ?? a + o.d));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
    const g = ctx.createGain();
    this.env(g.gain, t0, a, Math.max(o.peak, 0.0002), o.d);
    let head: AudioNode = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter;
      f.frequency.setValueAtTime(o.ff ?? 1000, t0);
      if (o.fto) f.frequency.exponentialRampToValueAtTime(Math.max(o.fto, 30), t0 + a + o.d);
      f.Q.value = o.q ?? 0.8;
      head.connect(f);
      head = f;
    }
    head.connect(g);
    this.route(g, o);
    osc.start(t0);
    osc.stop(t0 + a + o.d + 0.08);
    this.active++;
    osc.onended = () => { this.active--; g.disconnect(); };
  }

  private noise(o: NoiseOpts) {
    if (!this.ready()) return;
    const pri = o.pri ?? 1;
    if (!this.allow(pri)) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.at || 0);
    const a = o.a ?? 0.004;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf!;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.freq ?? 1200, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(o.to, 30), t0 + a + o.dur);
    f.Q.value = o.q ?? 0.9;
    const g = ctx.createGain();
    this.env(g.gain, t0, a, Math.max(o.peak, 0.0002), o.dur);
    src.connect(f);
    f.connect(g);
    this.route(g, o);
    // random offset into the shared looped buffer = free variation, zero
    // allocation, and no length limit for long swells
    src.loop = true;
    src.start(t0, rand(0, 1.9));
    src.stop(t0 + a + o.dur + 0.1);
    this.active++;
    src.onended = () => { this.active--; g.disconnect(); };
  }

  // momentary duck on a bus gain (attack → hold → recover)
  private duck(node: GainNode | null, depth: number, attack: number, hold: number, release: number) {
    if (!node || !this.ctx) return;
    const g = node.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(depth, t + attack);
    g.setValueAtTime(depth, t + attack + hold);
    g.linearRampToValueAtTime(1, t + attack + hold + release);
  }

  // ========================================================== adaptive music
  // The pad is the dream itself: an A drone whose filter opens with battle
  // intensity, whose chord third slides minor when a boss walks the dream,
  // plus sparse pentatonic chimes when calm, a heartbeat when near death and
  // a low pulse while the boss lives.
  private startMusic() {
    if (!this.ctx || this.musicStarted) return;
    this.musicStarted = true;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 620;
    // starts silent; the scheduler's setTargetAtTime smoothing blooms it in
    // over the first ~3 s (an explicit ramp here would fight those events)
    this.padLevel = ctx.createGain();
    this.padLevel.gain.setValueAtTime(0, t);
    this.padFilter.connect(this.padLevel);
    this.padLevel.connect(this.musicBus!);

    // slow filter breathing, independent of gameplay
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 210;
    lfo.connect(lfoG);
    lfoG.connect(this.padFilter.frequency);
    lfo.start();

    // partials: A1 A2 E3 A3 + a movable third and color tone. Static pans give
    // the drone width; tiny detune LFOs keep it alive.
    const mk = (freq: number, type: OscillatorType, gain: number, pan: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = rand(-6, 6);
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p);
        p.connect(this.padFilter!);
      } else g.connect(this.padFilter!);
      o.start();
      const w = ctx.createOscillator();
      w.frequency.value = rand(0.03, 0.08);
      const wg = ctx.createGain();
      wg.gain.value = rand(4, 9);
      w.connect(wg);
      wg.connect(o.detune);
      w.start();
      return o;
    };
    mk(nt(-12), 'sine', 0.075, 0);        // A1
    mk(nt(0), 'triangle', 0.05, -0.15);   // A2
    mk(nt(7), 'sine', 0.042, 0.15);       // E3
    mk(nt(12), 'sine', 0.028, -0.25);     // A3
    this.oscThird = mk(nt(19), 'sine', 0.02, 0.2);   // C#4 (glides to C4)
    this.oscColor = mk(nt(14), 'sine', 0.016, -0.2); // B3 (glides to G3)

    // 120 ms scheduler: smooths intensity, glides the chord, and schedules
    // chimes / heartbeat / boss pulse slightly ahead on the audio clock
    this.nextChime = ctx.currentTime + rand(1.5, 3);
    this.tickTimer = window.setInterval(() => this.musicTick(), 120);
  }

  private musicTick() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    this.mIntensity += (this.tIntensity - this.mIntensity) * 0.07;
    this.mDanger += (this.tDanger - this.mDanger) * 0.14;

    const darkTarget = this.boss ? 1 : 0;
    if (Math.abs(darkTarget - this.darkness) > 0.002) {
      this.darkness += (darkTarget - this.darkness) * 0.06;
      // major third ↔ minor third; add9 ↔ m7 color — threat without volume
      this.oscThird!.frequency.setTargetAtTime(nt(19) * Math.pow(2, -this.darkness / 12), now, 0.5);
      this.oscColor!.frequency.setTargetAtTime(nt(14) * Math.pow(2, -this.darkness * 4 / 12), now, 0.5);
    }
    this.padFilter!.frequency.setTargetAtTime(500 + 1250 * this.mIntensity + 260 * this.darkness, now, 0.6);
    this.padLevel!.gain.setTargetAtTime(0.55 + 0.3 * this.mIntensity, now, 0.9);

    // dream chimes: frequent and bright when calm, rare in chaos, gone in dread
    if (now >= this.nextChime) {
      const calm = 1 - this.mIntensity;
      if (this.darkness < 0.6 && this.enabled) {
        this.tone({
          freq: vary(pent(12 + ((Math.random() * 8) | 0)), 0.004), type: 'triangle',
          a: 0.01, d: rand(1.1, 1.7), peak: 0.016 + 0.02 * calm,
          pan: rand(-0.55, 0.55), verb: 0.75, bus: 'music', pri: 0,
        });
      }
      this.nextChime = now + rand(2.2, 6.0) + this.mIntensity * 5;
    }

    // heartbeat under low HP — lub-dub, quickening as death nears
    if (this.mDanger > 0.06) {
      if (this.nextBeat < now) this.nextBeat = now + 0.03;
      while (this.nextBeat < now + 0.4) {
        const k = this.mDanger;
        this.thump(this.nextBeat - now, 0.085 * k, 64);
        this.thump(this.nextBeat - now + 0.17, 0.05 * k, 56);
        this.nextBeat += 1.0 - 0.4 * k;
      }
    } else this.nextBeat = 0;

    // boss pulse: a slow dark ostinato on A1/E1 while the Devourer lives
    if (this.boss && this.darkness > 0.25) {
      if (this.nextPulse < now) this.nextPulse = now + 0.03;
      while (this.nextPulse < now + 0.4) {
        this.pulseAlt = !this.pulseAlt;
        this.tone({
          freq: this.pulseAlt ? nt(-12) : nt(-17), type: 'sawtooth',
          a: 0.012, d: 0.3, peak: 0.055 * this.darkness,
          filter: 'lowpass', ff: 210, q: 1.2,
          at: this.nextPulse - now, bus: 'music', pri: 1,
        });
        this.nextPulse += 0.46;
      }
    } else this.nextPulse = 0;
  }

  private thump(at: number, peak: number, freq: number) {
    this.tone({ freq, to: freq * 0.6, glide: 0.09, a: 0.006, d: 0.16, peak, at, bus: 'music', pri: 1 });
  }

  // Engine feed (~10 Hz): battle intensity 0..1, danger 0..1 (low HP), boss up
  gameState(intensity: number, danger: number, boss: boolean) {
    this.tIntensity = clamp(intensity, 0, 1);
    this.tDanger = clamp(danger, 0, 1);
    this.boss = boss;
  }

  // mood presets for the non-run screens
  menuMood() {
    this.tIntensity = 0.15; this.tDanger = 0; this.boss = false;
    if (this.dimMusic && this.ctx) this.dimMusic.gain.setTargetAtTime(1, this.ctx.currentTime, 0.8);
  }

  // a slow inhale as the dream begins
  runStart() {
    this.gemDeg = 0; this.lastGem = 0;
    this.tIntensity = 0.3; this.tDanger = 0; this.boss = false;
    if (this.dimMusic && this.ctx) this.dimMusic.gain.setTargetAtTime(1, this.ctx.currentTime, 0.5);
    if (!this.ready()) return;
    this.noise({ dur: 1.1, a: 0.55, peak: 0.045, freq: 380, to: 1400, q: 0.6, type: 'lowpass', verb: 0.5, pri: 3 });
    [nt(12), nt(19), nt(24)].forEach((f, i) => // A3 C#4 A4 bloom
      this.tone({ freq: f, type: 'sine', a: 0.4, d: 1.1, peak: 0.035 - i * 0.008, at: 0.15, verb: 0.6, pri: 3 }));
  }

  // ============================================================= spell casts
  // Each school keeps a distinct identity, but every pitch is palette-tuned.
  castArcane(pan = 0) {
    if (this.throttled('arcane', 55)) return;
    const rg = this.busy('arcane', 500);
    const f = vary(pent(13 + ((Math.random() * 3) | 0))); // E5/F#5/A5
    this.tone({ freq: f, to: f * 1.5, glide: 0.06, type: 'triangle', d: 0.09, peak: 0.03 * rg, pan, verb: 0.15 });
    this.tone({ freq: f * 1.19, to: f * 1.7, glide: 0.05, type: 'sine', d: 0.07, peak: 0.018 * rg, at: 0.03, pan: pan * 0.5 });
  }

  castEmber() {
    if (this.throttled('ember', 70)) return;
    const rg = this.busy('ember', 600);
    this.noise({ dur: 0.2, peak: 0.08 * rg, freq: vary(820, 0.1), to: 250, q: 0.8, verb: 0.18 });
    this.tone({ freq: vary(nt(12)), to: nt(0), type: 'triangle', d: 0.16, peak: 0.06 * rg });
  }

  castFrost() {
    if (this.throttled('frost', 120)) return;
    // glassy rising gliss E6→B6 with icy air
    this.tone({ freq: vary(nt(43)), to: nt(50), glide: 0.26, type: 'sine', d: 0.3, peak: 0.045, verb: 0.5 });
    this.noise({ dur: 0.32, peak: 0.05, freq: 5400, q: 2.2, verb: 0.3 });
    this.tone({ freq: vary(nt(48)), type: 'sine', d: 0.18, peak: 0.02, at: 0.06, pan: rand(-0.3, 0.3), verb: 0.5 });
  }

  castStorm() {
    if (this.throttled('storm', 90)) return;
    const rg = this.busy('storm', 700);
    this.noise({ dur: 0.15, peak: 0.13 * rg, freq: 2800, to: 500, q: 0.6, verb: 0.45 });
    this.tone({ freq: nt(-5), to: nt(-12), type: 'sawtooth', d: 0.12, peak: 0.06 * rg, filter: 'lowpass', ff: 900 });
    this.noise({ dur: 0.5, a: 0.03, peak: 0.04 * rg, freq: 220, to: 90, type: 'lowpass', at: 0.05, verb: 0.4 });
  }

  castVoid() {
    if (this.throttled('void', 200)) return;
    // a hungry mouth opening: detuned pair falling two octaves
    this.tone({ freq: nt(12), to: nt(-12), glide: 0.7, type: 'sine', d: 0.8, peak: 0.1, verb: 0.4 });
    this.tone({ freq: nt(12) * 1.012, to: nt(-12) * 1.02, glide: 0.7, type: 'sine', d: 0.8, peak: 0.07 });
    this.noise({ dur: 0.7, a: 0.45, peak: 0.04, freq: 320, q: 0.7, type: 'lowpass', verb: 0.4 });
  }

  bossBlink() {
    // the Shade folding into a seam: castVoid's hungry mouth breathing IN —
    // a detuned pair rising two octaves under a tightening hiss. The rise is
    // answered by castVoid's fall when the body steps out at the exit.
    if (this.throttled('blink', 350)) return;
    this.tone({ freq: nt(-12), to: nt(12), glide: 0.5, type: 'sine', d: 0.55, peak: 0.09, verb: 0.4, pri: 2 });
    this.tone({ freq: nt(-12) * 1.012, to: nt(12) * 1.02, glide: 0.5, type: 'sine', d: 0.55, peak: 0.06, verb: 0.4, pri: 2 });
    this.noise({ dur: 0.5, a: 0.4, peak: 0.035, freq: 500, to: 2600, q: 0.8, type: 'bandpass', verb: 0.5, pri: 2 });
  }

  castMoon() {
    if (this.throttled('moon', 260)) return;
    // choir-lit hum: darkened saws under a rising E–A dyad
    this.tone({ freq: nt(7), to: nt(12), type: 'sawtooth', d: 0.3, peak: 0.035, glide: 0.26, filter: 'lowpass', ff: 850, verb: 0.35 });
    this.tone({ freq: vary(nt(31)), to: nt(36), type: 'sine', d: 0.3, peak: 0.03, glide: 0.26, verb: 0.4 });
  }

  castStarfall() {
    if (this.throttled('starfall', 150)) return;
    const rg = this.busy('starfall', 700);
    this.tone({ freq: vary(nt(48)), to: nt(24), glide: 0.4, type: 'sine', d: 0.45, peak: 0.045 * rg, verb: 0.3 });
    this.noise({ dur: 0.2, peak: 0.028 * rg, freq: 6200, q: 1.6, type: 'highpass', verb: 0.3 });
  }

  castUmbra() {
    if (this.throttled('umbra', 80)) return;
    const rg = this.busy('umbra', 600);
    this.noise({ dur: 0.11, peak: 0.075 * rg, freq: vary(640, 0.1), to: 200, q: 1.3 });
    this.tone({ freq: nt(10), to: nt(-2), type: 'sawtooth', d: 0.12, peak: 0.042 * rg, filter: 'lowpass', ff: 700 });
  }

  castGlaive() {
    if (this.throttled('glaive', 140)) return;
    const rg = this.busy('glaive', 700);
    // metallic starlight ping arcing upward
    this.tone({ freq: vary(nt(31)), to: nt(50), glide: 0.15, type: 'triangle', d: 0.2, peak: 0.045 * rg, verb: 0.4 });
    this.tone({ freq: vary(nt(43)), type: 'sine', d: 0.24, peak: 0.025 * rg, at: 0.02, verb: 0.45 });
    this.noise({ dur: 0.09, peak: 0.025 * rg, freq: 4200, q: 1.4, type: 'highpass' });
  }

  castNebula() {
    if (this.throttled('nebula', 300)) return;
    // a soft stellar bloom: A3 + E4 + B4 swelling out of nothing
    [nt(12), nt(19), nt(26)].forEach((f, i) =>
      this.tone({ freq: vary(f, 0.004), type: 'sine', a: 0.25, d: 0.8, peak: 0.045 - i * 0.01, at: i * 0.05, verb: 0.6 }));
    this.noise({ dur: 0.9, a: 0.4, peak: 0.025, freq: 900, q: 0.5, type: 'lowpass', verb: 0.5 });
  }

  castSigil() {
    if (this.throttled('sigilCast', 160)) return;
    // the rune being inscribed: a small bell and a quill tick
    this.tone({ freq: vary(nt(36)), type: 'sine', d: 0.35, peak: 0.035, verb: 0.55 });
    this.tone({ freq: vary(nt(43)), type: 'sine', d: 0.25, peak: 0.015, at: 0.04, verb: 0.55 });
    this.noise({ dur: 0.04, peak: 0.02, freq: 3200, q: 1.5, type: 'highpass' });
  }

  castLantern() {
    if (this.throttled('lantern', 110)) return;
    const f = vary(nt(31)); // E5 bell with a soft 2nd partial
    this.tone({ freq: f, type: 'sine', d: 0.5, peak: 0.04, verb: 0.5 });
    this.tone({ freq: f * 2.01, type: 'sine', d: 0.35, peak: 0.014, verb: 0.5 });
  }

  castNova() {
    if (this.throttled('nova', 220)) return;
    this.noise({ dur: 0.38, peak: 0.12, freq: 520, to: 90, q: 0.7, type: 'lowpass', verb: 0.3 });
    this.tone({ freq: nt(12), to: nt(-12), glide: 0.35, type: 'sine', d: 0.45, peak: 0.12 });
  }

  // Somnal Ward: a glassy chime as a pane drinks a blow
  wardHit(pan = 0) {
    if (this.throttled('wardHit', 70)) return;
    const rg = this.busy('wardHit', 350);
    const f = vary(nt(36), 0.01); // A5
    this.tone({ freq: f, type: 'sine', d: 0.14, peak: 0.03 * rg, pan, verb: 0.4 });
    this.tone({ freq: f * 1.5, type: 'sine', d: 0.1, peak: 0.016 * rg, pan, verb: 0.4 });
    this.noise({ dur: 0.06, peak: 0.02 * rg, freq: 6800, q: 2, type: 'highpass', pan });
  }

  // Somnal Ward breaking: a bright shatter of glass over a soft dark boom
  wardBreak(pan = 0) {
    if (this.throttled('wardBreak', 200)) return;
    [nt(36), nt(43), nt(48), nt(52)].forEach((f, i) =>
      this.tone({ freq: vary(f, 0.02), type: 'sine', d: 0.4 - i * 0.05, peak: 0.045 - i * 0.008, at: i * 0.012, pan, verb: 0.55, pri: 1 }));
    this.noise({ dur: 0.4, a: 0.005, peak: 0.06, freq: 5200, to: 1200, q: 0.8, type: 'highpass', pan, verb: 0.4 });
    this.tone({ freq: nt(0), to: nt(-7), glide: 0.3, type: 'sine', d: 0.35, peak: 0.05, pan });
  }

  // Hush: a slow breath out — soft filtered swell under a low fading dyad
  hushSigh(pan = 0) {
    if (this.throttled('hushSigh', 300)) return;
    this.noise({ dur: 0.7, a: 0.25, peak: 0.04, freq: 900, to: 300, q: 0.6, type: 'lowpass', pan, verb: 0.5 });
    this.tone({ freq: nt(7), to: nt(2), glide: 0.5, type: 'sine', d: 0.6, peak: 0.03, pan, verb: 0.55 });
    this.tone({ freq: vary(nt(14)), type: 'sine', d: 0.4, peak: 0.014, at: 0.05, pan, verb: 0.6 });
  }

  petalTick(pan = 0) {
    if (this.throttled('petal', 120)) return;
    const rg = this.busy('petal', 350);
    this.tone({ freq: vary(pent(15 + ((Math.random() * 5) | 0)), 0.01), type: 'sine', d: 0.05, peak: 0.018 * rg, pan, pri: 0 });
  }

  // ------- the twelve new schools -------
  // Wisp Choir: each dart is a tiny voice; overlapping darts land on a triad
  wispDart(pan = 0) {
    if (this.throttled('wisp', 100)) return;
    const rg = this.busy('wisp', 400);
    const f = vary(pent(12 + ((Math.random() * 3) | 0)), 0.006); // A4/B4/C#5
    this.tone({ freq: f, to: f * 1.26, glide: 0.05, type: 'sine', d: 0.09, peak: 0.02 * rg, pan, verb: 0.35, pri: 0 });
  }

  // Dream Serpent: a low watery glide under a panning swish
  castSerpent() {
    if (this.throttled('serpent', 400)) return;
    this.tone({ freq: nt(0), to: nt(-7), glide: 0.55, type: 'triangle', d: 0.7, peak: 0.06, filter: 'lowpass', ff: 620, verb: 0.4 });
    this.noise({ dur: 0.8, a: 0.25, peak: 0.045, freq: 480, to: 160, q: 0.6, type: 'lowpass', verb: 0.45 });
    this.tone({ freq: vary(nt(19)), type: 'sine', d: 0.3, peak: 0.02, at: 0.12, verb: 0.5 });
  }

  // Chime of Hours: an inharmonic bell; the crescendo adds a sub-gong
  castChime(crescendo = false) {
    if (this.throttled('chime', 160)) return;
    const rg = this.busy('chime', 900);
    const f = vary(nt(24), 0.004); // A4 bell
    this.tone({ freq: f, type: 'sine', d: crescendo ? 1.1 : 0.6, peak: (crescendo ? 0.075 : 0.045) * rg, verb: 0.6, pri: crescendo ? 2 : 1 });
    this.tone({ freq: f * 2.76, type: 'sine', d: crescendo ? 0.7 : 0.35, peak: (crescendo ? 0.028 : 0.016) * rg, verb: 0.6 });
    if (crescendo) {
      this.tone({ freq: nt(0), to: nt(-5), glide: 0.5, type: 'triangle', d: 1.2, peak: 0.08 * rg, filter: 'lowpass', ff: 500, verb: 0.55, pri: 2 });
      this.noise({ dur: 0.9, a: 0.3, peak: 0.03, freq: 2400, q: 0.6, type: 'highpass', verb: 0.6 });
    }
  }

  // Sleepless Eye: a slow choral drone that holds while the gaze sweeps
  castEye() {
    if (this.throttled('eye', 900)) return;
    this.tone({ freq: nt(12), type: 'sawtooth', a: 0.4, d: 1.8, peak: 0.028, filter: 'lowpass', ff: 700, fto: 1600, q: 0.7, verb: 0.6, pri: 2 });
    this.tone({ freq: nt(12) * 1.008, type: 'sawtooth', a: 0.45, d: 1.7, peak: 0.022, filter: 'lowpass', ff: 650, verb: 0.6 });
    this.tone({ freq: nt(19), type: 'sine', a: 0.5, d: 1.6, peak: 0.02, verb: 0.65 });
    this.tone({ freq: nt(28), type: 'sine', a: 0.6, d: 1.4, peak: 0.012, verb: 0.7 });
  }

  // Nightmare Brand: a dissonant sting — the one sound allowed off-palette
  castBrand(pan = 0) {
    if (this.throttled('brand', 300)) return;
    this.tone({ freq: nt(15), type: 'sawtooth', d: 0.3, peak: 0.035, filter: 'lowpass', ff: 1100, pan, verb: 0.35, pri: 2 });
    this.tone({ freq: nt(16), type: 'sawtooth', d: 0.3, peak: 0.03, filter: 'lowpass', ff: 1100, pan, verb: 0.35, pri: 2 });
    this.tone({ freq: 95, to: 40, glide: 0.2, type: 'sine', d: 0.3, peak: 0.09, pan: pan * 0.5, pri: 2 });
  }

  // the debt collected, one slow heartbeat per tick
  brandThump(pan = 0) {
    if (this.throttled('brandthump', 380)) return;
    this.tone({ freq: 70, to: 46, glide: 0.08, type: 'sine', d: 0.13, peak: 0.045, pan, pri: 0 });
  }

  // Kaleidoscope: a glassy arpeggio when placed…
  castPrism() {
    if (this.throttled('prism', 350)) return;
    [nt(24), nt(28), nt(31), nt(36)].forEach((f, i) =>
      this.tone({ freq: vary(f, 0.004), type: 'triangle', d: 0.22, peak: 0.028 - i * 0.004, at: i * 0.05, verb: 0.55 }));
  }

  // …and each ray a pure ping stepping through the scale
  prismRay(pan = 0) {
    if (this.throttled('prismray', 110)) return;
    const rg = this.busy('prismray', 450);
    this.prismStep = (this.prismStep + 1) % 5;
    this.tone({ freq: vary(pent(15 + this.prismStep), 0.004), type: 'sine', d: 0.1, peak: 0.022 * rg, pan, verb: 0.4, pri: 0 });
  }
  private prismStep = 0;

  // ================================================================= impacts
  explode(pan = 0) {
    if (this.throttled('boom', 70)) return;
    const rg = this.busy('boom', 900);
    this.tone({ freq: vary(130, 0.08), to: 42, glide: 0.3, type: 'sine', d: 0.38, peak: 0.18 * rg, pan: pan * 0.6, pri: 2 });
    this.noise({ dur: 0.42, peak: 0.14 * rg, freq: 460, to: 80, q: 0.7, type: 'lowpass', pan, verb: 0.35, pri: 2 });
    this.noise({ dur: 0.07, peak: 0.04 * rg, freq: 3000, q: 0.8, type: 'highpass', pan, pri: 2 });
  }

  sigilBoom(pan = 0) {
    if (this.throttled('sigil', 160)) return;
    const rg = this.busy('sigil', 800);
    // a gong of waking: tonal fall + bloom of air
    this.tone({ freq: nt(24), to: nt(7), glide: 0.3, type: 'triangle', d: 0.4, peak: 0.09 * rg, pan, verb: 0.5, pri: 2 });
    this.tone({ freq: nt(12), to: nt(0), glide: 0.4, type: 'sine', d: 0.5, peak: 0.07 * rg, pan: pan * 0.5, verb: 0.4, pri: 2 });
    this.noise({ dur: 0.32, peak: 0.09 * rg, freq: 850, to: 170, q: 0.9, pan, verb: 0.4, pri: 2 });
  }

  // ================================================================== combat
  // Per-tick damage stays a near-subliminal tick; the *kill* carries the
  // reward, so chaos reads as victory instead of static.
  hit(pan = 0) {
    if (this.throttled('hit', 50)) return;
    const rg = this.busy('hit', 400);
    this.noise({ dur: 0.04, peak: 0.032 * rg, freq: vary(2200, 0.25), q: 1.4, pan, pri: 0 });
  }

  // the payoff pop: pitched from the palette, softer when kills are torrential
  kill(pan = 0, elite = false) {
    if (this.throttled('kill', 30)) return;
    const rg = this.busy('kill', 600);
    const f = vary(pent(5 + ((Math.random() * 4) | 0))); // A3..E4
    if (elite) {
      this.tone({ freq: f * 0.5, to: f * 0.2, glide: 0.12, type: 'sine', d: 0.24, peak: 0.15, pan, pri: 2 });
      this.noise({ dur: 0.16, peak: 0.08, freq: 700, to: 180, q: 0.8, type: 'lowpass', pan, pri: 2 });
      this.tone({ freq: nt(31), type: 'sine', d: 0.3, peak: 0.045, at: 0.03, pan, verb: 0.45, pri: 2 });
      this.tone({ freq: nt(36), type: 'sine', d: 0.35, peak: 0.035, at: 0.07, pan, verb: 0.45, pri: 2 });
    } else {
      this.tone({ freq: f, to: f * 0.42, glide: 0.08, type: 'sine', d: 0.1, peak: 0.1 * rg, pan, pri: 2 });
      this.noise({ dur: 0.07, peak: 0.045 * rg, freq: 900, to: 260, q: 0.9, type: 'lowpass', pan, pri: 1 });
    }
  }

  enemyShot(pan = 0) {
    if (this.throttled('eshot', 140)) return;
    const rg = this.busy('eshot', 700);
    this.tone({ freq: vary(330, 0.06), to: 196, type: 'square', d: 0.1, peak: 0.026 * rg, pan, filter: 'lowpass', ff: 900 });
  }

  hurt() {
    if (this.throttled('hurt', 240)) return;
    // dark thud + a semitone rub — pain leaves the palette
    this.tone({ freq: 110, to: 38, glide: 0.2, type: 'sine', d: 0.28, peak: 0.22, pri: 2 });
    this.noise({ dur: 0.18, peak: 0.11, freq: 480, to: 120, type: 'lowpass', pri: 2 });
    this.tone({ freq: nt(15), type: 'sawtooth', d: 0.08, peak: 0.03, filter: 'lowpass', ff: 1200, pri: 2 }); // C4: minor sting
    this.duck(this.duckSfx, 0.55, 0.02, 0.12, 0.3);
  }

  // ============================================================ boss theatre
  bossOmen() {
    // dread rises before the Devourer breaks through
    this.tone({ freq: nt(-12), to: nt(0), glide: 2.6, type: 'sine', a: 1.2, d: 1.6, peak: 0.07, verb: 0.5, pri: 3 });
    this.tone({ freq: nt(-12) * 1.03, to: nt(3), glide: 2.6, type: 'sine', a: 1.4, d: 1.4, peak: 0.05, verb: 0.5, pri: 3 });
    this.noise({ dur: 2.2, a: 1.6, peak: 0.05, freq: 300, to: 900, q: 0.6, type: 'bandpass', verb: 0.5, pri: 3 });
  }

  bossRoar() {
    const rumbleF = vary(66, 0.05);
    this.tone({ freq: rumbleF, to: 27.5, glide: 1.3, type: 'sawtooth', d: 1.6, peak: 0.2, filter: 'lowpass', ff: 320, fto: 110, pri: 3 });
    this.noise({ dur: 1.3, peak: 0.12, freq: 240, to: 60, type: 'lowpass', verb: 0.5, pri: 3 });
    // a semitone cluster — the dream itself goes wrong
    this.tone({ freq: nt(0), type: 'sine', a: 0.1, d: 1.2, peak: 0.05, verb: 0.6, pri: 3 });
    this.tone({ freq: nt(1), type: 'sine', a: 0.1, d: 1.2, peak: 0.045, verb: 0.6, pri: 3 });
    this.duck(this.duckMusic, 0.4, 0.05, 0.6, 1.2);
    this.duck(this.duckSfx, 0.7, 0.05, 0.5, 0.8);
  }

  bossEnrage(pan = 0) {
    // the nightmare's patience snaps: a rising dissonant snarl, sharper than the
    // arrival roar, warning the dreamer to end this now
    this.tone({ freq: vary(88, 0.05), to: 220, glide: 0.5, type: 'sawtooth', d: 0.6, peak: 0.14, filter: 'lowpass', ff: 700, fto: 1800, pan, pri: 3 });
    this.tone({ freq: nt(1), to: nt(8), glide: 0.5, type: 'square', a: 0.02, d: 0.5, peak: 0.05, filter: 'lowpass', ff: 1400, pan, pri: 3 });
    this.tone({ freq: nt(2), to: nt(10), glide: 0.5, type: 'sawtooth', a: 0.02, d: 0.5, peak: 0.04, filter: 'lowpass', ff: 1400, pan, pri: 3 }); // semitone rub climbing
    this.noise({ dur: 0.4, peak: 0.08, freq: 600, to: 2400, q: 0.7, type: 'bandpass', pan, pri: 3 });
    this.duck(this.duckSfx, 0.7, 0.03, 0.3, 0.4);
  }

  bossDown() {
    // relief and triumph: impact, then an A-major swell and a sparkling run
    this.tone({ freq: 120, to: 40, glide: 0.4, type: 'sine', d: 0.55, peak: 0.2, pri: 3 });
    this.noise({ dur: 0.6, peak: 0.13, freq: 420, to: 70, type: 'lowpass', verb: 0.4, pri: 3 });
    [nt(12), nt(19), nt(24), nt(31)].forEach((f, i) =>
      this.tone({ freq: f, type: 'triangle', a: 0.05, d: 1.3, peak: 0.06, at: 0.25 + i * 0.03, verb: 0.7, pri: 3 }));
    [15, 17, 18, 20].forEach((deg, i) =>
      this.tone({ freq: pent(deg), type: 'sine', d: 0.5, peak: 0.04, at: 0.5 + i * 0.06, pan: rand(-0.4, 0.4), verb: 0.6, pri: 3 }));
    this.duck(this.duckSfx, 0.5, 0.03, 0.5, 0.6);
  }

  // ================================================================= pickups
  // XP gems climb a pentatonic ladder while the streak lasts — collecting is
  // literally a rising melody, and a pause lets it fall back down.
  gem() {
    const now = performance.now();
    if (now - this.lastGem > 900) this.gemDeg = 0;
    else if (now - this.lastGem < 40) return; // same-frame vacuum: one voice
    this.lastGem = now;
    const deg = 10 + this.gemDeg;            // A4 upward
    const f = vary(pent(deg), 0.006);
    this.tone({ freq: f, type: 'sine', d: 0.09, peak: 0.042, verb: 0.12, pri: 2 });
    this.tone({ freq: f * 2, type: 'sine', d: 0.07, peak: 0.016, pri: 1 });
    if (this.gemDeg < 14) this.gemDeg++;
    else if (Math.random() < 0.25) { // shimmer at the top of the ladder
      this.tone({ freq: f * 1.5, type: 'sine', d: 0.12, peak: 0.02, at: 0.03, verb: 0.3, pri: 1 });
    }
  }

  heal() {
    if (this.throttled('heal', 180)) return;
    this.tone({ freq: nt(24), to: nt(28), glide: 0.2, type: 'sine', d: 0.28, peak: 0.05, verb: 0.4, pri: 3 });
    this.tone({ freq: nt(31), type: 'sine', d: 0.3, peak: 0.035, at: 0.07, verb: 0.4, pri: 3 });
  }

  shard() {
    // the Dark Bargain's coin: a dissonant glint resolving home
    this.tone({ freq: nt(26), type: 'sine', d: 0.12, peak: 0.05, verb: 0.5, pri: 3 });  // B4
    this.tone({ freq: nt(27), type: 'sine', d: 0.12, peak: 0.04, at: 0.02, verb: 0.5, pri: 3 }); // C5 rub
    this.tone({ freq: nt(24), type: 'triangle', d: 0.45, peak: 0.05, at: 0.12, verb: 0.6, pri: 3 }); // resolve A4
  }

  starPickup() {
    if (this.throttled('star', 300)) return;
    [12, 14, 15, 17].forEach((deg, i) =>
      this.tone({ freq: vary(pent(deg), 0.005), type: 'triangle', d: 0.4, peak: 0.055, at: i * 0.05, verb: 0.55, pri: 3 }));
    this.noise({ dur: 0.35, peak: 0.035, freq: 6000, q: 1.2, type: 'highpass', verb: 0.5, pri: 3 });
    this.tone({ freq: nt(24), type: 'sine', a: 0.05, d: 0.7, peak: 0.04, at: 0.1, verb: 0.6, pri: 3 });
  }

  starFallen() {
    // a far-off bell: something worth walking toward
    this.tone({ freq: nt(36), type: 'sine', d: 1.2, peak: 0.03, pan: rand(-0.5, 0.5), verb: 0.85, pri: 3 });
    this.tone({ freq: nt(43), type: 'sine', d: 0.9, peak: 0.018, at: 0.12, verb: 0.85, pri: 3 });
  }

  bonus() {
    // golden wisp / stardust: coin-bright and unmistakable
    this.tone({ freq: nt(43), type: 'sine', d: 0.28, peak: 0.055, verb: 0.4, pri: 3 });
    this.tone({ freq: nt(48), type: 'sine', d: 0.35, peak: 0.045, at: 0.05, verb: 0.4, pri: 3 });
    this.noise({ dur: 0.25, peak: 0.025, freq: 7000, q: 1.2, type: 'highpass', verb: 0.4, pri: 3 });
  }

  darkReveal() {
    // the Wound opens — the Constellation's bright flourish, soured: a low swell
    // curdling into an unresolved crimson cluster and a gritty, breathing exhale
    this.duck(this.duckSfx, 0.4, 0.05, 0.9, 0.7);
    this.tone({ freq: nt(-24), to: nt(-5), glide: 1.0, type: 'sawtooth', a: 0.4, d: 1.5, peak: 0.13, filter: 'lowpass', ff: 380, fto: 1100, verb: 0.5, pri: 3 });
    this.tone({ freq: nt(3), type: 'triangle', a: 0.16, d: 1.2, peak: 0.06, verb: 0.6, pri: 3 });   // C5
    this.tone({ freq: nt(4), type: 'sine', a: 0.16, d: 1.2, peak: 0.05, verb: 0.6, pri: 3 });        // C#5 — a minor-second rub that won't resolve
    this.tone({ freq: nt(-2), type: 'sawtooth', a: 0.2, d: 1.0, peak: 0.045, filter: 'lowpass', ff: 900, verb: 0.5, pri: 3 }); // F#4 tritone tension
    this.noise({ dur: 1.2, a: 0.5, peak: 0.06, freq: 190, to: 720, q: 0.5, type: 'bandpass', verb: 0.55, pri: 3 });
    this.tone({ freq: nt(-17), type: 'sine', d: 1.5, peak: 0.05, at: 0.45, verb: 0.7, pri: 3 }); // a slow toll waking beneath
  }

  goldenWisp() {
    // a beckoning flit — chase me
    [17, 19, 20].forEach((deg, i) =>
      this.tone({ freq: vary(pent(deg), 0.006), type: 'sine', d: 0.22, peak: 0.03, at: i * 0.07, pan: rand(-0.4, 0.4), verb: 0.6, pri: 3 }));
  }

  // =============================================================== moments
  levelUp() {
    // collapse back-to-back openings (multi-level gems) into one flourish
    if (this.throttled('levelUp', 600)) return;
    this.duck(this.duckSfx, 0.35, 0.04, 0.7, 0.5);
    const run = [10, 12, 13, 15, 17, 20]; // A4 C#5 E5 A5 C#6 A6
    run.forEach((deg, i) => {
      const f = pent(deg);
      this.tone({ freq: f, type: 'triangle', d: 0.5, peak: 0.085 - i * 0.005, at: i * 0.07, verb: 0.6, pri: 3 });
      this.tone({ freq: f / 2, type: 'sine', d: 0.5, peak: 0.045, at: i * 0.07, verb: 0.4, pri: 3 });
    });
    this.noise({ dur: 0.5, a: 0.25, peak: 0.03, freq: 7500, q: 1, type: 'highpass', at: 0.2, verb: 0.6, pri: 3 });
    this.tone({ freq: pent(20) * 2, type: 'sine', d: 0.7, peak: 0.03, at: run.length * 0.07, verb: 0.7, pri: 3 });
  }

  choose() {
    // warm confirmation: a soft A–E dyad blooming outward
    this.tone({ freq: nt(24), type: 'triangle', a: 0.012, d: 0.4, peak: 0.065, verb: 0.4, pri: 3 });
    this.tone({ freq: nt(31), type: 'sine', a: 0.012, d: 0.45, peak: 0.045, at: 0.03, verb: 0.45, pri: 3 });
    this.tone({ freq: nt(36), type: 'sine', d: 0.3, peak: 0.02, at: 0.09, verb: 0.5, pri: 3 });
  }

  reroll() {
    // the offered dream scatters and reforms
    this.noise({ dur: 0.24, peak: 0.04, freq: 1200, to: 2600, q: 1, verb: 0.3, pri: 3 });
    [18, 16, 15, 17, 19].forEach((deg, i) =>
      this.tone({ freq: vary(pent(deg), 0.008), type: 'sine', d: 0.14, peak: 0.032, at: i * 0.045, pan: rand(-0.5, 0.5), verb: 0.4, pri: 3 }));
  }

  banish() {
    // cast out of the dream: a dark falling whoosh
    this.noise({ dur: 0.28, peak: 0.08, freq: 800, to: 150, q: 0.9, verb: 0.3, pri: 3 });
    this.tone({ freq: nt(12), to: nt(-5), glide: 0.26, type: 'sine', d: 0.3, peak: 0.055, pri: 3 });
  }

  death() {
    // the dream closes over you: falling motif, then the deep A fades in and
    // the music dims for the waking screen
    if (this.dimMusic && this.ctx) this.dimMusic.gain.setTargetAtTime(0.3, this.ctx.currentTime, 1.4);
    this.tIntensity = 0.1; this.tDanger = 0; this.boss = false;
    const motif = [nt(24), nt(21), nt(19), nt(15), nt(12)]; // A4 F#4 E4 C4 A3 — minor shadowed
    motif.forEach((f, i) => {
      this.tone({ freq: f, to: f * 0.985, glide: 0.9, type: 'triangle', d: 1.1, peak: 0.09, at: i * 0.32, verb: 0.7, pri: 3 });
      this.tone({ freq: f / 2, type: 'sine', d: 1.1, peak: 0.04, at: i * 0.32, verb: 0.5, pri: 3 });
    });
    this.tone({ freq: nt(0), type: 'sine', a: 0.6, d: 2.4, peak: 0.1, at: 1.5, verb: 0.6, pri: 3 });
    this.tone({ freq: nt(-12), type: 'sine', a: 0.8, d: 2.6, peak: 0.08, at: 1.6, verb: 0.5, pri: 3 });
    this.noise({ dur: 2.4, a: 0.9, peak: 0.035, freq: 420, q: 0.5, type: 'lowpass', at: 0.8, verb: 0.6, pri: 3 });
  }

  waveEvent() {
    // the tide gathers: a short dark swell under the banner
    if (this.throttled('wave', 1200)) return;
    this.tone({ freq: nt(0), to: nt(3), glide: 0.8, type: 'sine', a: 0.35, d: 0.9, peak: 0.06, verb: 0.5, pri: 3 });
    this.noise({ dur: 1.0, a: 0.5, peak: 0.04, freq: 500, to: 1100, q: 0.7, verb: 0.5, pri: 3 });
  }

  // ==================================================================== UI
  uiHover() {
    if (this.throttled('uiHover', 70)) return;
    this.tone({ freq: vary(nt(43), 0.01), type: 'sine', d: 0.035, peak: 0.012, bus: 'ui', pri: 0 });
  }

  uiClick() {
    if (this.throttled('uiClick', 60)) return;
    this.tone({ freq: nt(36), to: nt(31), type: 'sine', d: 0.06, peak: 0.03, bus: 'ui', pri: 1 });
    this.noise({ dur: 0.02, peak: 0.014, freq: 2400, q: 1, type: 'highpass', bus: 'ui', pri: 0 });
  }
}

export const audio = new AudioEngine();
