// Pooled particle system. Everything dreamlike in Dreamtide flows through here.
// Particles are cosmetic-only, so they update on the RENDER clock (per rAF
// frame, real dt) — they stay silky at any refresh rate and never touch the
// fixed-step simulation.
//
// This module is simulation only: drawing happens on the WebGPU sprite pass
// (render.ts maps each mode to an atlas sprite quad — stars, shards, petals,
// runes and velocity-stretched sparks all keep their real shapes).

import { settings } from './settings';

export type ParticleMode = 'glow' | 'spark' | 'shard' | 'ring' | 'petal' | 'rune' | 'smoke' | 'star';

export interface Particle {
  alive: boolean;
  x: number; y: number; vx: number; vy: number; ax: number; ay: number;
  drag: number; life: number; maxLife: number;
  size: number; endSize: number;
  color: string; color2: string | null;
  mode: ParticleMode;
  rot: number; rotV: number;
  wobble: number; wobbleF: number;
  seed: number; glow: number;
  noDim: boolean; // exempt from the spell-fade dimming (the Dreamer's own FX)
}

export interface SpawnOpts {
  x: number; y: number;
  vx?: number; vy?: number; ax?: number; ay?: number; drag?: number;
  life?: number; size?: number; endSize?: number;
  color?: string; color2?: string;
  mode?: ParticleMode; rot?: number; rotV?: number;
  wobble?: number; wobbleF?: number; glow?: number; keep?: boolean;
}

// Initial pool size. The live-count ceiling and the adaptive emission budget
// (SOFT) are read from `settings` each spawn so the performance presets apply
// live: below SOFT every spawn is honoured; past it an increasing share of new
// cosmetic particles are dropped — invisible thinning among overlapping glows.
// On the "unlimited" preset the pool grows past this on demand (see spawn()).
const INITIAL = 3600;
const SINK = { alive: false } as Particle;

function makeParticle(): Particle {
  return {
    alive: false, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, drag: 1,
    life: 0, maxLife: 1, size: 3, endSize: 0, color: '#fff', color2: null,
    mode: 'glow', rot: 0, rotV: 0, wobble: 0, wobbleF: 3, seed: 0, glow: 1,
    noDim: false,
  };
}

export class ParticleSystem {
  // Pre-allocate every particle object once (no per-spawn GC). Live particles
  // are packed into [0, count); dead ones are swap-removed.
  pool: Particle[];
  count = 0;
  overwrite = 0;
  // while true, particles spawn exempt from the boss-duel spell-fade (used to
  // keep the Other Dreamer's own attacks and the safe/hit feedback at full glow)
  keepBright = false;

  constructor() {
    this.pool = new Array(INITIAL);
    for (let i = 0; i < INITIAL; i++) this.pool[i] = makeParticle();
  }

  clear() { this.count = 0; this.overwrite = 0; }

  spawn(opts: SpawnOpts): Particle {
    const soft = settings.particleSoft;
    if (this.count > soft && !opts.keep) {
      const over = (this.count - soft) / 400;
      if (Math.random() < Math.min(0.985, over * (1.2 + over))) { SINK.alive = false; return SINK; }
    }
    const max = settings.particleMax;
    let p: Particle;
    if (this.count < max) {
      // grow the pool on demand (the "unlimited" preset lets count exceed the
      // initial allocation; low/med/high never reach their ceiling in practice)
      if (this.count >= this.pool.length) this.pool.push(makeParticle());
      p = this.pool[this.count++];
    } else {
      // at the live ceiling: recycle the oldest live slot in-place
      p = this.pool[this.overwrite % max];
      this.overwrite = (this.overwrite + 1) % max;
    }
    p.alive = true;
    p.x = opts.x;
    p.y = opts.y;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.ax = opts.ax ?? 0;
    p.ay = opts.ay ?? 0;
    p.drag = opts.drag ?? 1;
    p.life = p.maxLife = opts.life ?? 0.8;
    p.size = opts.size ?? 3;
    p.endSize = opts.endSize ?? 0;
    p.color = opts.color ?? '#ffffff';
    p.color2 = opts.color2 ?? null;
    p.mode = opts.mode ?? 'glow';
    p.rot = opts.rot ?? Math.random() * Math.PI * 2;
    p.rotV = opts.rotV ?? 0;
    p.wobble = opts.wobble ?? 0;
    p.wobbleF = opts.wobbleF ?? 3;
    p.seed = Math.random() * 1000;
    p.glow = opts.glow ?? 1;
    p.noDim = this.keepBright;
    return p;
  }

  update(dt: number) {
    let i = 0;
    while (i < this.count) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        const last = --this.count;
        if (i !== last) {
          this.pool[i] = this.pool[last];
          this.pool[last] = p;
        }
        continue;
      }
      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      if (p.drag !== 1) {
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d;
        p.vy *= d;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.wobble) {
        p.x += Math.sin(p.seed + p.life * p.wobbleF * 6) * p.wobble * dt * 60;
      }
      p.rot += p.rotV * dt;
      i++;
    }
  }
}
