// Enemy sprite cache: bakes each enemy type's animated *shape* into a small
// sprite-sheet of offscreen canvases, once, at supersampled resolution. At
// runtime an enemy collapses from ~40 Canvas2D path ops into a single
// drawImage — the draw-call count is what the browser's compositor process is
// actually bound on in the endgame (halving render resolution didn't move it,
// which proves it is per-draw overhead, not fill-rate).
//
// WHAT IS BAKED vs LIVE
//   baked  : the internal shape morph driven by animT (wing flap, flame lick,
//            robe hem ripple, tentacle wiggle). Discretised into FRAMES steps
//            of a canonical loop; per-enemy `seed` selects a frame, so enemies
//            are never in lockstep — same visual as the live version.
//   live   : bob/hover, hit-flash, freeze-tint, rotation, elite/golden corona,
//            and the eye's player-tracking iris. Applied by the caller at blit
//            time so the motions the eye actually locks onto stay continuous.
//
// TINT: only three body states exist (normal / white hit-flash / frozen blue),
// so each is a separate baked variant rather than a per-pixel runtime multiply.

export const FRAMES = 24;          // animation-loop samples per type
const SS = 2;                      // supersample factor (bake at 2x, downscale)
const PAD = 10;                    // px padding around the art (glow spill)
export type TintKind = 'normal' | 'flash' | 'frozen';
const TINTS: TintKind[] = ['normal', 'flash', 'frozen'];
export const ENEMY_KINDS = ['wisp', 'bat', 'eye', 'shade', 'golem', 'siren', 'warlock'];

// Half-extent of each type's art in local (pre-scale) space, generous enough
// to contain glows/coronas/tentacles. Keyed to the same local coords the draw
// code uses. Bosses reuse the 'eye' sheet scaled up by the caller.
const HALF: Record<string, number> = {
  wisp: 26, bat: 30, eye: 34, shade: 30, golem: 34, siren: 24, warlock: 26,
};

// A baked type: FRAMES frames × 3 tints. Each entry is an offscreen canvas of
// size (2*half+2*PAD)*SS. `half` is the local-space half-extent so the caller
// can position/scale correctly.
interface Baked {
  half: number;
  size: number;              // canvas pixel size (already *SS)
  frames: HTMLCanvasElement[][]; // [tint][frame]
}

const _cache = new Map<string, Baked>();

// Parametric body painters: draw the type's shape at loop phase `ph` in [0,1),
// in local space centred at (0,0), with the given tint colour (null = none).
// These mirror the live drawX functions but take an explicit phase instead of
// (animT, seed), so a fixed set of frames tiles the whole animation loop.
type Painter = (ctx: CanvasRenderingContext2D, ph: number, tint: string | null) => void;

const TAU = Math.PI * 2;

const PAINTERS: Record<string, Painter> = {
  wisp(ctx, ph, tint) {
    const a = ph * TAU;
    const f = Math.sin(a);          // flame lick, one full cycle across the sheet
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = radial(ctx, 20, tint || '#dffcff', '#7ff5ff');
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, TAU); ctx.fill();
    ctx.fillStyle = tint || 'rgba(190,250,255,0.85)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 6 - 3, 2);
      ctx.quadraticCurveTo(i * 7 + f * 3, -14 - Math.abs(i) * -4, i * 6 + f * 4, -20 - f * 3 + Math.abs(i) * 6);
      ctx.quadraticCurveTo(i * 8 + 3, -8, i * 6 + 3, 2);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = tint || '#eafeff';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0b2a3a';
    const blink = Math.sin(a * 1.3) > 0.92 ? 0.2 : 1;
    ctx.beginPath();
    ctx.ellipse(-3.2, -1, 1.4, 2.4 * blink, 0, 0, TAU);
    ctx.ellipse(3.2, -1, 1.4, 2.4 * blink, 0, 0, TAU);
    ctx.fill();
  },

  bat(ctx, ph, tint) {
    const a = ph * TAU;
    const flap = Math.sin(a);       // one wingbeat across the sheet
    // (hover bob is applied LIVE by the caller, not baked)
    ctx.fillStyle = tint || '#5b3a9e';
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.rotate(-flap * 0.55);
      ctx.beginPath();
      ctx.moveTo(4, -2);
      ctx.quadraticCurveTo(16, -14, 26, -6);
      ctx.quadraticCurveTo(20, -1, 22, 5);
      ctx.quadraticCurveTo(15, 2, 14, 8);
      ctx.quadraticCurveTo(9, 4, 4, 6);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = tint || '#7a55c9';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(5, 0); ctx.lineTo(24, -5);
      ctx.moveTo(5, 2); ctx.lineTo(15, 6);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = tint || '#7a55c9';
    ctx.beginPath(); ctx.ellipse(0, 0, 7.5, 9.5, 0, 0, TAU); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-5, -7); ctx.lineTo(-6.5, -14); ctx.lineTo(-1.5, -9);
    ctx.moveTo(5, -7); ctx.lineTo(6.5, -14); ctx.lineTo(1.5, -9);
    ctx.closePath(); ctx.fill();
    // eyes: bake the fake-glow dot + core (glow via radial, no shadowBlur)
    softGlow(ctx, -2.8, -2, 6, 'rgba(255,90,122,0.75)');
    softGlow(ctx, 2.8, -2, 6, 'rgba(255,90,122,0.75)');
    ctx.fillStyle = '#ff5a7a';
    ctx.beginPath(); ctx.arc(-2.8, -2, 1.5, 0, TAU); ctx.arc(2.8, -2, 1.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-2, 4); ctx.lineTo(-1, 7); ctx.lineTo(0, 4);
    ctx.moveTo(2, 4); ctx.lineTo(1, 7); ctx.lineTo(0, 4);
    ctx.fill();
  },

  // eye: bake the eyeball WITHOUT the iris (iris tracks the player → drawn live
  // as a tiny quad by the caller). Tentacle wiggle + blink lid are baked.
  eye(ctx, _ph, tint) {
    // Tentacles are NOT baked here anymore. Baking them into FRAMES samples of a
    // slow loop always read as choppy — and the boss magnifies it because it's
    // scaled up (every per-frame pixel-jump grows with it). Instead the crown of
    // tentacles is a static, radially-symmetric sprite ('tentacles') emitted as a
    // single LIVE quad that rotates continuously — smooth at any scale, like the
    // boss shard crown. So the baked eye body is just the eyeball + veins.
    ctx.fillStyle = tint || '#fdeef6';
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill();
    // veins (static)
    ctx.strokeStyle = 'rgba(200,80,120,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-13, -4); ctx.quadraticCurveTo(-8, -2, -7, 2);
    ctx.moveTo(12, 5); ctx.quadraticCurveTo(8, 3, 7, -1);
    ctx.stroke();
  },

  shade(ctx, ph, tint) {
    const wave = ph * TAU;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(60,40,120,0.35)';
    ctx.beginPath(); ctx.ellipse(-Math.sin(wave) * 4, 12, 12, 5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = linGrad(ctx, 0, -22, 0, 16, tint || '#4a3a96', tint || '#1c1440');
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.quadraticCurveTo(14, -18, 13, 0);
    for (let i = 0; i <= 6; i++) {
      const fr = i / 6;
      ctx.lineTo(13 - fr * 26, 8 + Math.sin(wave + fr * 8) * 4 - fr * 2);
    }
    ctx.quadraticCurveTo(-14, -18, 0, -24);
    ctx.fill();
    ctx.fillStyle = '#0a0618';
    ctx.beginPath(); ctx.ellipse(0, -14, 6.5, 7.5, 0, 0, TAU); ctx.fill();
    softGlow(ctx, -2.6, -14, 7, 'rgba(154,140,255,0.7)');
    softGlow(ctx, 2.6, -14, 7, 'rgba(154,140,255,0.7)');
    ctx.fillStyle = '#9a8cff';
    const squint = 1 + Math.sin(ph * TAU) * 0.3;
    ctx.beginPath();
    ctx.ellipse(-2.6, -14, 1.5, 2 * squint, 0.2, 0, TAU);
    ctx.ellipse(2.6, -14, 1.5, 2 * squint, -0.2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#cfd0ee';
    ctx.lineWidth = 1.8;
    const reach = Math.sin(wave * 0.7) * 2;
    ctx.beginPath();
    ctx.moveTo(9, -8); ctx.lineTo(15, -4 + reach);
    ctx.moveTo(15, -4 + reach); ctx.lineTo(17, -6 + reach);
    ctx.moveTo(15, -4 + reach); ctx.lineTo(18, -3 + reach);
    ctx.stroke();
    ctx.globalAlpha = 1;
  },

  golem(ctx, ph, tint) {
    const a = ph * TAU;
    const breathe = Math.sin(a) * 1.5;
    // orbiting rock chunks are emitted as LIVE quads by the caller (a full
    // orbit baked over 24 frames read as choppy); body only is baked here.
    ctx.fillStyle = linGrad(ctx, 0, -20, 0, 16, tint || '#7fb7d9', tint || '#2a4a72');
    ctx.beginPath();
    ctx.moveTo(0, -22 - breathe);
    ctx.lineTo(14, -10); ctx.lineTo(18, 6); ctx.lineTo(8, 14);
    ctx.lineTo(-8, 14); ctx.lineTo(-18, 6); ctx.lineTo(-14, -10);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(143,232,255,0.35)';
    ctx.lineWidth = 4.6 + breathe;
    ctx.beginPath();
    ctx.moveTo(-6, -12); ctx.lineTo(-2, -4); ctx.lineTo(-7, 4);
    ctx.moveTo(6, -10); ctx.lineTo(3, 0); ctx.lineTo(9, 8);
    ctx.stroke();
    ctx.strokeStyle = '#8fe8ff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-6, -12); ctx.lineTo(-2, -4); ctx.lineTo(-7, 4);
    ctx.moveTo(6, -10); ctx.lineTo(3, 0); ctx.lineTo(9, 8);
    ctx.stroke();
    softGlow(ctx, 0, -14 - breathe * 0.5, 11, 'rgba(191,249,255,0.55)');
    ctx.fillStyle = '#bff9ff';
    ctx.beginPath();
    ctx.ellipse(0, -14 - breathe * 0.5, 6, 1.8 + Math.sin(a) * 0.6, 0, 0, TAU);
    ctx.fill();
  },

  // siren: bake the resting (non-charging) look; the charging mouth-glow +
  // note motes are handled live by the caller. Veils sway is baked.
  siren(ctx, ph, tint) {
    const a = ph * TAU;
    ctx.fillStyle = tint || 'rgba(125,201,255,0.4)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 4, -6);
      ctx.quadraticCurveTo(side * 16, 2 + Math.sin(a + side) * 3, side * 10, 14);
      ctx.quadraticCurveTo(side * 6, 6, side * 2, 8);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = linGrad(ctx, 0, -16, 0, 12, tint || '#bfe4ff', tint || '#3a6ea8');
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.quadraticCurveTo(9, -6, 7, 6);
    ctx.quadraticCurveTo(4, 13, 0, 14);
    ctx.quadraticCurveTo(-4, 13, -7, 6);
    ctx.quadraticCurveTo(-9, -6, 0, -16);
    ctx.fill();
    ctx.fillStyle = '#0b2a3a';
    ctx.beginPath(); ctx.ellipse(0, -2, 2.4, 3.4, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#0b2a3a';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(-3.4, -8, 1.8, 0.2, Math.PI - 0.2);
    ctx.arc(3.4, -8, 1.8, 0.2, Math.PI - 0.2);
    ctx.stroke();
  },

  warlock(ctx, ph, tint) {
    const a = ph * TAU;
    ctx.fillStyle = linGrad(ctx, 0, -20, 0, 16, tint || '#7a3aa8', tint || '#2a1040');
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.quadraticCurveTo(13, -14, 12, 2);
    ctx.quadraticCurveTo(14, 12, 8, 14);
    ctx.lineTo(-8, 14);
    ctx.quadraticCurveTo(-14, 12, -12, 2);
    ctx.quadraticCurveTo(-13, -14, 0, -22);
    ctx.fill();
    ctx.fillStyle = '#12081f';
    ctx.beginPath(); ctx.ellipse(0, -13, 6, 7, 0, 0, TAU); ctx.fill();
    softGlow(ctx, -2.4, -13, 6, 'rgba(255,154,213,0.75)');
    softGlow(ctx, 2.4, -13, 6, 'rgba(255,154,213,0.75)');
    ctx.fillStyle = '#ff9ad5';
    ctx.beginPath(); ctx.arc(-2.4, -13, 1.3, 0, TAU); ctx.arc(2.4, -13, 1.3, 0, TAU); ctx.fill();
    // floating grimoire (slow bob/tilt so 24 frames stay smooth)
    const pf = Math.sin(a) * 0.15;
    ctx.save();
    ctx.translate(12, -4 + Math.sin(a) * 2);
    ctx.rotate(-0.3 + pf);
    ctx.fillStyle = '#3d2159';
    ctx.fillRect(-5, -3.5, 10, 7);
    ctx.fillStyle = '#e3bfff';
    ctx.fillRect(-4, -2.5, 4, 5);
    ctx.fillRect(0.5, -2.5, 3.5, 5);
    ctx.restore();
    // orbiting charge-orbs are emitted as LIVE quads by the caller (smooth)
  },
};

// tint colour for the frozen state (mirrors mixHint in render.ts)
function tintColor(kind: TintKind): string | null {
  if (kind === 'flash') return '#ffffff';
  if (kind === 'frozen') return '#bfe9ff';
  return null;
}

function build(type: string): Baked {
  const painter = PAINTERS[type];
  const half = HALF[type];
  const px = Math.ceil((half + PAD) * 2 * SS);
  const frames: HTMLCanvasElement[][] = [[], [], []];
  for (let ti = 0; ti < TINTS.length; ti++) {
    const tint = tintColor(TINTS[ti]);
    for (let f = 0; f < FRAMES; f++) {
      const c = document.createElement('canvas');
      c.width = c.height = px;
      const g = c.getContext('2d')!;
      g.setTransform(SS, 0, 0, SS, (half + PAD) * SS, (half + PAD) * SS);
      painter(g, f / FRAMES, tint);
      frames[ti].push(c);
    }
  }
  return { half, size: px, frames };
}

export function getBaked(type: string): Baked {
  let b = _cache.get(type);
  if (!b) { b = build(type); _cache.set(type, b); }
  return b;
}

// Pre-bake up front (one-time). Builds the GPU atlas; also keeps the per-type
// offscreen sheets for the Canvas2D no-WebGPU fallback path.
export function prebakeEnemies() {
  buildAtlas();
  for (const type of Object.keys(PAINTERS)) getBaked(type);
}

// Draw enemy body from its baked sheet. `ctx` is already translated to the
// enemy centre and scaled to its on-screen size; we blit the frame centred.
// Returns nothing. tintKind picks the baked variant.
export function blitEnemy(ctx: CanvasRenderingContext2D, type: string, ph: number, tintKind: TintKind) {
  const b = getBaked(type);
  const ti = tintKind === 'flash' ? 1 : tintKind === 'frozen' ? 2 : 0;
  let fi = (ph * FRAMES) | 0;
  fi = ((fi % FRAMES) + FRAMES) % FRAMES;
  const spr = b.frames[ti][fi];
  const d = b.half + PAD;
  ctx.drawImage(spr, -d, -d, d * 2, d * 2);
}

export function enemyHalf(type: string): number { return HALF[type]; }

// ---- local baking helpers (self-contained; don't touch the live gradient
// caches in engine.ts, since these run at 2x supersampled scale) ----
function radial(ctx: CanvasRenderingContext2D, r: number, c0: string, c1: string): CanvasGradient {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, c0);
  if (c1.startsWith('rgba') && c1.endsWith(',0)')) { g.addColorStop(1, c1); }
  else { g.addColorStop(0.45, c1); g.addColorStop(1, 'rgba(0,0,0,0)'); }
  return g;
}

// ============================================================ sprite atlas
// One texture holding every static sprite the GPU world renderer draws:
// enemy body frames (type × tint × FRAMES), gems/orbs, projectile bodies,
// the fallen-star pickup. Each entry records its UV rect in the atlas and its
// world half-extent so the renderer can size the quad. Built once per run.

export interface AtlasEntry {
  u0: number; v0: number; u1: number; v1: number; // UV rect in [0,1]
  half: number;   // FULL quad half-extent in world units (art half + PAD ring).
                  // The renderer multiplies this by the entity's scale to size
                  // the quad; it must span the whole padded sprite, not just
                  // the art, or the sprite draws shrunk and inset.
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  size: number;                       // atlas is size×size px
  entries: Map<string, AtlasEntry>;
}

// stable sprite id for an enemy body frame
export function enemyFrameId(type: string, tint: TintKind, frame: number): string {
  return `e:${type}:${tint}:${frame}`;
}

let _atlas: Atlas | null = null;

// A small extra painter set for the non-enemy world sprites (gems, projectiles,
// pickups). Each draws centred at (0,0) in a local space of half-extent `half`.
interface ExtraSprite { id: string; half: number; paint: (ctx: CanvasRenderingContext2D) => void }

function extraSprites(): ExtraSprite[] {
  const out: ExtraSprite[] = [];
  // gem variants: [id, coreColor, spikeColor, coreSize]
  const gemDefs: [string, string, number][] = [
    ['gem:xp', '#7ff5ff', 5.5],
    ['gem:big', '#ffd27a', 8],
    ['gem:heal', '#7dffb0', 9],
  ];
  for (const [id, c, s] of gemDefs) {
    out.push({
      id, half: s * 2.6, paint(ctx) {
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 2.4);
        g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, s * 2.4, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.lineTo(s * 0.62, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.62, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.5); ctx.lineTo(s * 0.26, 0); ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.26, 0);
        ctx.closePath(); ctx.fill();
      },
    });
  }
  // merged dreamshard
  out.push({
    id: 'gem:merged', half: 6.5 * 2.6, paint(ctx) {
      const s = 6.5;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 2.4);
      g.addColorStop(0, '#e6d1ff'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, s * 2.4, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#c8a8ff';
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.62, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.62, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, TAU); ctx.fill();
    },
  });
  // arcane missile body (rotates live; glow baked round)
  out.push({
    id: 'proj:arcane', half: 15, paint(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, '#b48cff'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 14, 0, TAU); ctx.fill();
      ctx.fillStyle = '#e6d1ff';
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(-8, 4.4); ctx.lineTo(-4, 0); ctx.lineTo(-8, -4.4);
      ctx.closePath(); ctx.fill();
    },
  });
  // ember blob
  out.push({
    id: 'proj:ember', half: 16, paint(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 16);
      g.addColorStop(0, '#fff6d8'); g.addColorStop(0.4, '#ffd27a'); g.addColorStop(1, 'rgba(255,90,60,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 16, 0, TAU); ctx.fill();
    },
  });
  // fang crescent
  out.push({
    id: 'proj:fang', half: 18, paint(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
      g.addColorStop(0, 'rgba(138,92,217,0.85)'); g.addColorStop(1, 'rgba(32,18,61,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 18, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#c9a4ff';
      ctx.beginPath();
      ctx.arc(0, 0, 12, -1.25, 1.25);
      ctx.arc(-5, 0, 10, 1.05, -1.05, true);
      ctx.closePath(); ctx.fill();
    },
  });
  // astral glaive: a twin-bladed star-blade baked at its natural size so the
  // renderer draws it crisp (rotated live via pr.spin). Local +x is one blade
  // tip; the mirror blade points -x. Icy-blue palette.
  out.push({
    id: 'proj:glaive', half: 30, paint(ctx) {
      // faint icy aura so the blade never reads as a hard cutout — kept tight
      // and low-alpha so it hugs the blade rather than blooming into an orb
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
      g.addColorStop(0, 'rgba(159,216,255,0.28)'); g.addColorStop(1, 'rgba(159,216,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 20, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      for (const side of [0, Math.PI]) {
        ctx.save();
        ctx.rotate(side);
        // blade body
        ctx.fillStyle = '#e8f6ff';
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.quadraticCurveTo(20, -18, 30, -4);
        ctx.quadraticCurveTo(20, -7, 8, 5);
        ctx.closePath();
        ctx.fill();
        // keen edge
        ctx.strokeStyle = '#9fd8ff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(8, 1);
        ctx.quadraticCurveTo(20, -8, 30, -4);
        ctx.stroke();
        ctx.restore();
      }
      // bright hub
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, 4.2, 0, TAU); ctx.fill();
    },
  });
  // boss/enemy bullet (dark dart + hot core; glow drawn separately as a quad)
  out.push({
    id: 'proj:bullet', half: 12, paint(ctx) {
      ctx.fillStyle = '#1a0a14';
      ctx.strokeStyle = 'rgba(255,210,215,0.95)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(11, 0); ctx.lineTo(2, -3); ctx.lineTo(-2, -6); ctx.lineTo(-4, -2);
      ctx.lineTo(-9, 0); ctx.lineTo(-4, 2); ctx.lineTo(-2, 6); ctx.lineTo(2, 3);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ff5a6e'; ctx.beginPath(); ctx.arc(0.5, 0, 3.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd6da'; ctx.beginPath(); ctx.arc(0.5, 0, 1.5, 0, TAU); ctx.fill();
    },
  });
  // a plain soft white glow quad, tinted per-instance for bullet halos / misc
  out.push({
    id: 'glow', half: 32, paint(ctx) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 32);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 32, 0, TAU); ctx.fill();
    },
  });
  // eye iris: pink orb + dark pupil + white highlight. Drawn as one alpha quad,
  // rotated per-instance toward the player (the eye body is baked iris-less).
  // Local +x points toward the player after the quad's rotation, so the pupil
  // sits offset along +x.
  out.push({
    id: 'iris', half: 9, paint(ctx) {
      const off = 5; // pupil offset toward look direction (+x)
      const g = ctx.createRadialGradient(off, 0, 0, off, 0, 8);
      g.addColorStop(0, '#ff9ad5'); g.addColorStop(1, '#8a2a5e');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(off, 0, 7.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#1a0a14'; ctx.beginPath(); ctx.arc(off, 0, 3.4, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(off - 2, -2.4, 1.4, 0, TAU); ctx.fill();
    },
  });
  // eye tentacle crown: 7 arms radiating from the eyeball, baked once as a
  // static radially-symmetric sprite. Emitted as a single live quad that spins
  // slowly, so the motion is continuous at any scale (no baked frame-stepping).
  // Drawn UNDER the eyeball body by the caller. Half-extent matches the eye art.
  out.push({
    id: 'tentacles', half: 34, paint(ctx) {
      ctx.strokeStyle = '#c76ba3';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      for (let i = 0; i < 7; i++) {
        const ta = (i / 7) * TAU;
        const cs = Math.cos(ta), sn = Math.sin(ta);
        // a gentle fixed curl gives each arm an organic hook; because the whole
        // sprite rotates live, the hooks sweep smoothly around the eye
        const px = -sn, py = cs, curl = 3;
        ctx.beginPath();
        ctx.moveTo(cs * 14, sn * 14);
        ctx.quadraticCurveTo(cs * 22 + px * curl, sn * 22 + py * curl, cs * 27, sn * 27 - 2);
        ctx.stroke();
      }
    },
  });
  // boss crown shard: a small violet diamond, drawn as several rotated quads
  out.push({
    id: 'shard', half: 6, paint(ctx) {
      ctx.fillStyle = '#c48cff';
      ctx.beginPath();
      ctx.moveTo(0, -6); ctx.lineTo(3, 0); ctx.lineTo(0, 6); ctx.lineTo(-3, 0);
      ctx.closePath(); ctx.fill();
    },
  });
  // golem orbiting rock chunk (live quad, tinted per-instance)
  out.push({
    id: 'rock', half: 3.4, paint(ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
    },
  });
  // a hollow ring outline (white, tinted per-instance). Baked at a reference
  // radius; the caller scales the quad so the drawn stroke tracks the corona
  // size. Two concentric strokes read as the original elite/aura ring.
  out.push({
    id: 'ring', half: 32, paint(ctx) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0, 0, 30, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    },
  });
  // five-petal spirit blossom for Petal Waltz orbitals
  out.push({
    id: 'petal', half: 12, paint(ctx) {
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k % 2 ? '#ffd1ec' : '#7dffb0';
        ctx.save();
        ctx.rotate((k / 5) * TAU);
        ctx.beginPath();
        ctx.ellipse(0, -7, 3.2, 6.4, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, TAU); ctx.fill();
    },
  });
  // warlock orbiting charge-orb (soft pink glow, additive live quad)
  out.push({
    id: 'orb', half: 5, paint(ctx) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 5);
      g.addColorStop(0, '#ffd9f2'); g.addColorStop(1, 'rgba(217,140,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    },
  });
  return out;
}

// Build the atlas: shelf-pack every sprite into a square texture. Enemy frames
// dominate the count (7 types × 3 tints × 24 = 504 tiles) but are small.
export function buildAtlas(): Atlas {
  if (_atlas) return _atlas;

  interface Tile { id: string; half: number; px: number; canvas: HTMLCanvasElement }
  const tiles: Tile[] = [];

  // enemy frames
  for (const type of ENEMY_KINDS) {
    const painter = PAINTERS[type];
    const half = HALF[type];
    const px = Math.ceil((half + PAD) * 2 * SS);
    for (const tint of TINTS) {
      const tc = tintColor(tint);
      for (let f = 0; f < FRAMES; f++) {
        const c = document.createElement('canvas');
        c.width = c.height = px;
        const g = c.getContext('2d')!;
        g.setTransform(SS, 0, 0, SS, (half + PAD) * SS, (half + PAD) * SS);
        painter(g, f / FRAMES, tc);
        tiles.push({ id: enemyFrameId(type, tint, f), half, px, canvas: c });
      }
    }
  }
  // extra sprites (gems, projectiles, pickups, glow)
  for (const es of extraSprites()) {
    const px = Math.ceil((es.half + PAD) * 2 * SS);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d')!;
    g.setTransform(SS, 0, 0, SS, (es.half + PAD) * SS, (es.half + PAD) * SS);
    es.paint(g);
    tiles.push({ id: es.id, half: es.half, px, canvas: c });
  }

  // shelf pack, tallest-first, into a power-of-two square
  tiles.sort((a, b) => b.px - a.px);
  const totalArea = tiles.reduce((s, t) => s + t.px * t.px, 0);
  let size = 256;
  // Initial size GUESS only — the pack loop below grows `size` if tiles don't
  // fit, so this just needs to be a rough lower bound, not a safe upper one.
  // The headroom factor covers shelf-packing waste (rows leave gaps under short
  // tiles). It was 1.35, but for the current sprite set that overshot 4096² by
  // ~2% and forced the guess to 8192 — quadrupling atlas memory (256MB→ vs
  // 64MB per copy) even though the tiles pack fine into 4096². 1.2 still clears
  // the real waste while letting 4096 be tried first; the loop remains the
  // actual safety net if a future sprite set genuinely needs more.
  while (size * size < totalArea * 1.2) size *= 2;
  // try to place; grow if a shelf run overflows
  const entries = new Map<string, AtlasEntry>();
  const GAP = 2;
  for (;;) {
    entries.clear();
    let x = GAP, y = GAP, shelfH = 0, ok = true;
    for (const t of tiles) {
      if (x + t.px + GAP > size) { x = GAP; y += shelfH + GAP; shelfH = 0; }
      if (y + t.px + GAP > size) { ok = false; break; }
      entries.set(t.id, {
        u0: x / size, v0: y / size,
        u1: (x + t.px) / size, v1: (y + t.px) / size,
        half: t.half + PAD, // full padded half-extent = px/(2*SS)
      });
      x += t.px + GAP;
      if (t.px > shelfH) shelfH = t.px;
    }
    if (ok) break;
    size *= 2;
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  for (const t of tiles) {
    const e = entries.get(t.id)!;
    ctx.drawImage(t.canvas, Math.round(e.u0 * size), Math.round(e.v0 * size));
  }

  _atlas = { canvas, size, entries };
  return _atlas;
}

export function getAtlas(): Atlas { return _atlas || buildAtlas(); }
function linGrad(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c0: string, c1: string): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  return g;
}
function softGlow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.restore();
}
