// Pooled particle system. Everything dreamlike in Dreamtide flows through here.
// Particles are cosmetic-only, so they update on the RENDER clock (per rAF
// frame, real dt) — they stay silky at any refresh rate and never touch the
// fixed-step simulation.

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
}

export interface SpawnOpts {
  x: number; y: number;
  vx?: number; vy?: number; ax?: number; ay?: number; drag?: number;
  life?: number; size?: number; endSize?: number;
  color?: string; color2?: string;
  mode?: ParticleMode; rot?: number; rotV?: number;
  wobble?: number; wobbleF?: number; glow?: number; keep?: boolean;
}

export interface CamRect { x: number; y: number; w: number; h: number }

// Initial pool size. The live-count ceiling and the adaptive emission budget
// (SOFT) are read from `settings` each spawn so the performance presets apply
// live: below SOFT every spawn is honoured; past it an increasing share of new
// cosmetic particles are dropped — invisible thinning among overlapping glows,
// big drop in draw calls + fill-rate. On the "unlimited" preset the ceiling is
// effectively infinite, so the pool grows past this on demand (see spawn()).
const INITIAL = 3600;
const SINK = { alive: false } as Particle;

// ---------------------------------------------------------------- glow sprites
// Baked radial-gradient sprites for the Canvas2D fallback path.
const GLOW_RES = 64;
const glowCache = new Map<string, HTMLCanvasElement>();

function glowSprite(color: string, color2: string | null, mode: string): HTMLCanvasElement {
  const key = mode + '|' + color + '|' + (color2 || '');
  let c = glowCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = GLOW_RES;
  const g = c.getContext('2d')!;
  const r = GLOW_RES / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  if (mode === 'smoke') {
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
  } else {
    grad.addColorStop(0, color);
    grad.addColorStop(0.55, color2 || color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, GLOW_RES, GLOW_RES);
  glowCache.set(key, c);
  return c;
}

function makeParticle(): Particle {
  return {
    alive: false, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, drag: 1,
    life: 0, maxLife: 1, size: 3, endSize: 0, color: '#fff', color2: null,
    mode: 'glow', rot: 0, rotV: 0, wobble: 0, wobbleF: 3, seed: 0, glow: 1,
  };
}

export class ParticleSystem {
  // Pre-allocate every particle object once (no per-spawn GC). Live particles
  // are packed into [0, count); dead ones are swap-removed.
  pool: Particle[];
  count = 0;
  overwrite = 0;

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

  // `skipSprites` is set when a GPU renderer draws the sprite modes
  // ('glow'/'smoke'). Canvas2D then only handles the cheap vector modes.
  draw(ctx: CanvasRenderingContext2D, cam: CamRect, skipSprites: boolean) {
    ctx.save();
    let curOp: GlobalCompositeOperation = 'source-over';
    ctx.globalCompositeOperation = curOp;
    for (let i = 0; i < this.count; i++) {
      const p = this.pool[i];
      if (skipSprites && (p.mode === 'glow' || p.mode === 'smoke')) continue;
      const t = p.life / p.maxLife; // 1 -> 0
      const x = p.x - cam.x;
      const y = p.y - cam.y;
      if (x < -80 || y < -80 || x > cam.w + 80 || y > cam.h + 80) continue;
      const size = p.endSize + (p.size - p.endSize) * t;
      if (size < 1.2) continue;
      const alpha = t < 0.35 ? t / 0.35 : 1;
      ctx.globalAlpha = Math.min(1, alpha);
      const op: GlobalCompositeOperation = p.mode === 'smoke' ? 'source-over' : 'lighter';
      if (op !== curOp) { ctx.globalCompositeOperation = op; curOp = op; }

      switch (p.mode) {
        case 'glow': {
          const spr = glowSprite(p.color, p.color2, 'glow');
          ctx.drawImage(spr, x - size, y - size, size * 2, size * 2);
          break;
        }
        case 'star': {
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            const a = (k * Math.PI) / 2;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a - 0.18) * size * 0.35, Math.sin(a - 0.18) * size * 0.35);
            ctx.lineTo(Math.cos(a) * size, Math.sin(a) * size);
            ctx.lineTo(Math.cos(a + 0.18) * size * 0.35, Math.sin(a + 0.18) * size * 0.35);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'spark': {
          const len = size * 2.4;
          const ang = Math.atan2(p.vy, p.vx);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.6, size * 0.32);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len);
          ctx.lineTo(x, y);
          ctx.stroke();
          break;
        }
        case 'shard': {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(0, -size);
          ctx.lineTo(size * 0.38, 0);
          ctx.lineTo(0, size);
          ctx.lineTo(-size * 0.38, 0);
          ctx.closePath();
          ctx.fill();
          if (p.color2) {
            ctx.fillStyle = p.color2;
            ctx.beginPath();
            ctx.moveTo(0, -size * 0.55);
            ctx.lineTo(size * 0.18, 0);
            ctx.lineTo(0, size * 0.55);
            ctx.lineTo(-size * 0.18, 0);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          break;
        }
        case 'ring': {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, size * 0.12 * t + 0.8);
          ctx.beginPath();
          ctx.arc(x, y, size * (1 - t * 0.9 + 0.1), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'petal': {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(0, -size * 0.5, size * 0.34, size * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'rune': {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.4;
          const s = size;
          ctx.beginPath();
          const glyph = Math.floor(p.seed) % 4;
          if (glyph === 0) {
            ctx.moveTo(-s, s); ctx.lineTo(0, -s); ctx.lineTo(s, s); ctx.moveTo(-s * 0.5, 0.2 * s); ctx.lineTo(s * 0.5, 0.2 * s);
          } else if (glyph === 1) {
            ctx.moveTo(0, -s); ctx.lineTo(0, s); ctx.moveTo(-s * 0.7, -s * 0.4); ctx.lineTo(s * 0.7, s * 0.4);
          } else if (glyph === 2) {
            ctx.arc(0, 0, s * 0.8, 0.4, Math.PI * 2 - 0.4); ctx.moveTo(0, -s); ctx.lineTo(0, s * 0.2);
          } else {
            ctx.moveTo(-s, 0); ctx.lineTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.closePath();
          }
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'smoke': {
          ctx.globalAlpha = Math.min(0.5, t * 0.5);
          const spr = glowSprite(p.color, null, 'smoke');
          ctx.drawImage(spr, x - size, y - size, size * 2, size * 2);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
}
