// Render layer: translates simulation state into GPU instance lists each
// frame, then draws the thin 2D overlay (damage text, health bars, banner,
// debug shapes, perf HUD) on top. All moving entities are drawn at positions
// interpolated between the last two fixed simulation steps, so motion is
// smooth at any display refresh rate.
//
// Everything world-space goes through eng.world (worldGPU.ts):
//   shapes (under)  : spell zones, beams, lightning — analytic SDF instances
//   quads           : lantern bodies, pickups, gems, player, enemies,
//                     orbitals, projectiles, particles — atlas sprites in
//                     painter's order, one draw call
//   shapes (over)   : melee slash arcs — combat feedback that must never be
//                     hidden behind the body that swings it

import type { Engine } from './engine';
import { ENEMY_TYPES, MELEE_ANIM_DUR, BLINK_IN, PLAYER_HURT_DY, PLAYER_HURT_R, STEP } from './engine';
import { TAU, clamp, type Enemy, type Zone, type Projectile, type BossProjectile, type Beam, type Bolt, type Gem, type Pickup } from './world';
import { enemyFrameId, wizardFrameId, FRAMES, WIZARD_CY } from './enemySprites';
import { SHAPE_RING, SHAPE_DISC, SHAPE_SPIRAL, SHAPE_CAPSULE, type QuadList, type ShapeList } from './worldGPU';
import { drawStats } from './perf';
import { settings } from './settings';

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

// generic colour parse → [r,g,b,a] 0..1 (cached). The alpha of rgba() strings
// MUST be honoured: the Canvas2D era baked it into each glow sprite's
// gradient, so effects authored as rgba(...,0.5) render at double strength if
// the GPU path drops it (the lantern's damage pulse became a white ball).
const _rgbCache = new Map<string, [number, number, number, number]>();
function rgb(str: string): [number, number, number, number] {
  let c = _rgbCache.get(str);
  if (c) return c;
  c = [1, 1, 1, 1];
  if (str[0] === '#') {
    let hx = str.slice(1);
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    const n = parseInt(hx, 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  } else if (str.startsWith('rgb')) {
    const m = str.match(/[\d.]+/g);
    if (m) c = [(+m[0]) / 255, (+m[1]) / 255, (+m[2]) / 255, m.length > 3 ? +m[3] : 1];
  }
  _rgbCache.set(str, c);
  return c;
}

// Damage-number sprites: floating texts redraw every frame (up to ~125 alive ×
// 2 fillText in a webfont — a burst-correlated raster spike). Each unique
// (string, size, colour) is rasterized once, backing shadow included, then
// blitted. The cache is evicted in halves when it grows past a bound (damage
// values churn endlessly late-game).
const _textCache = new Map<string, HTMLCanvasElement>();
let _fontReady = false;
function textSprite(str: string, size: number, color: string): HTMLCanvasElement {
  const key = str + '|' + size + '|' + color;
  let c = _textCache.get(key);
  if (c) return c;
  if (_textCache.size > 1200) {
    let n = 0;
    for (const k of _textCache.keys()) {
      _textCache.delete(k);
      if (++n >= 600) break;
    }
  }
  c = document.createElement('canvas');
  const font = `700 ${size}px Roboto, sans-serif`;
  const g = c.getContext('2d')!;
  g.font = font;
  const tw = Math.ceil(g.measureText(str).width);
  const base = Math.ceil(size * 1.25);
  c.width = tw + 8;
  c.height = Math.ceil(size * 1.75);
  // canvas resize resets state — set the font again before drawing
  g.font = font;
  g.textAlign = 'center';
  const cx = c.width / 2;
  g.fillStyle = 'rgba(6,4,16,0.6)';
  g.fillText(str, cx + 1.2, base + 1.2);
  g.fillStyle = color;
  g.fillText(str, cx, base);
  (c as any)._hw = cx;
  (c as any)._base = base;
  _textCache.set(key, c);
  return c;
}

export function renderFrame(eng: Engine, alpha: number, rdt: number) {
  const cam = eng.cam;
  const { w, h } = cam;
  const vt = eng.vt;
  const p = eng.player;
  drawStats.enemyBlits = 0;
  drawStats.enemyLiveOps = 0;

  // camera follows the interpolated player position, on the render clock
  const ipx = lerp(p.px, p.x, alpha);
  const ipy = lerp(p.py, p.y, alpha);
  if (rdt > 0) {
    cam.x += (ipx - w / 2 - cam.x) * Math.min(1, rdt * 6);
    cam.y += (ipy - h / 2 - cam.y) * Math.min(1, rdt * 6);
  }
  // Screen shake — rare by design (boss moments, taking a hit). A smooth
  // dual-sine tremor on the render camera, not per-frame random jitter: it
  // reads as an impact rather than unstable motion, and the same offset is
  // used for the overlay so text/bars never wobble against the world.
  let camX = cam.x, camY = cam.y;
  if (eng.shake > 0.3) {
    camX += Math.sin(vt * 63.7) * eng.shake * 0.45;
    camY += Math.cos(vt * 51.3) * eng.shake * 0.45;
  }

  const octx = eng.octx;
  if (octx) octx.clearRect(0, 0, w, h);
  const world = eng.world;
  if (!world) {
    // WebGPU device still attaching (first few frames) — nothing to draw yet.
    if (octx) eng.perf.draw(octx, w);
    return;
  }

  // ======================================================= GPU instance lists
  const pStart = performance.now();
  const q = eng.quads;
  const sh = eng.shapes;
  const shOver = eng.shapesOver;
  q.reset(); sh.reset(); shOver.reset();

  // lantern pools are alpha-blended and the Procession evolution keeps many
  // alive at once — dim each pool by the live count so stacked layers can
  // never compound into a solid wall of light
  let lanterns = 0;
  for (const z of eng.zones) if (z.kind === 'lantern') lanterns++;
  const lanternDim = lanterns > 1 ? 1 / (1 + 0.45 * (lanterns - 1)) : 1;
  for (const z of eng.zones) emitZone(sh, q, eng, z, alpha, camX, camY, lanternDim);
  for (const b of eng.beams) emitBeam(sh, eng, b, alpha, camX, camY);
  for (const b of eng.bolts) emitBolt(sh, b, alpha, camX, camY);
  for (const s of eng.pickups) emitPickup(q, eng, s, camX, camY);
  for (const g of eng.gems) emitGem(q, cam, g, alpha, camX, camY);
  emitPlayer(q, eng, ipx - camX, ipy - camY);
  for (const e of eng.enemies) emitEnemy(q, shOver, eng, e, alpha, camX, camY);
  emitOrbitals(q, eng, alpha, camX, camY);
  for (const pr of eng.projectiles) emitProjectile(q, eng, pr, alpha, camX, camY);
  for (const bp of eng.bossProjectiles) emitBossProjectile(q, sh, eng, bp, alpha, camX, camY);
  emitParticles(q, eng, camX, camY);

  world.render(vt, camX, camY, sh, q, shOver);
  drawStats.worldQuads = q.n;
  drawStats.worldShapes = sh.n + shOver.n;
  drawStats.worldDrawCalls = 3 + (shOver.n > 0 ? 1 : 0);
  eng.lastParticleDrawMs = performance.now() - pStart;

  // ======================================================= 2D overlay
  if (!octx) return;

  // debug overlay (H): every shape reads the same constants/radii the engine
  // uses (no drift).
  if (eng.debugHitbox) drawDebugHitboxes(eng, octx, ipx, ipy, alpha, camX, camY);

  // enemy health bars — crisp, full-res, capped by the performance preset
  drawHealthBars(eng, octx, camX, camY, alpha);

  // damage texts — sprite-cached once the webfont is in (fillText fallback
  // until then, so sprites never bake with the wrong font)
  if (!_fontReady && document.fonts && document.fonts.check('700 16px Roboto')) _fontReady = true;
  octx.save();
  if (_fontReady) {
    for (const t of eng.texts) {
      octx.globalAlpha = Math.min(1, t.life * 2);
      const spr = textSprite(t.str, t.size, t.color) as any;
      octx.drawImage(spr, t.x - camX - spr._hw, t.y - camY - spr._base);
    }
  } else {
    octx.textAlign = 'center';
    let curFont = 0;
    for (const t of eng.texts) {
      octx.globalAlpha = Math.min(1, t.life * 2);
      if (t.size !== curFont) { octx.font = `700 ${t.size}px Roboto, sans-serif`; curFont = t.size; }
      const tx = t.x - camX, ty = t.y - camY;
      octx.fillStyle = 'rgba(6,4,16,0.6)';
      octx.fillText(t.str, tx + 1.2, ty + 1.2);
      octx.fillStyle = t.color;
      octx.fillText(t.str, tx, ty);
    }
  }
  octx.restore();

  // edge arrows toward off-screen fallen stars
  for (const s of eng.pickups) {
    const sx = s.x - camX, sy = s.y - camY;
    if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) continue;
    const ax = clamp(sx, 46, w - 46), ay = clamp(sy, 46, h - 46);
    const ang = Math.atan2(sy - ay, sx - ax);
    octx.save();
    octx.translate(ax, ay);
    octx.rotate(ang);
    octx.globalAlpha = 0.55 + 0.3 * Math.sin(vt * 5);
    const arrowC = s.kind === 'altar' ? '#c48cff' : '#7ff5ff';
    octx.fillStyle = arrowC;
    octx.shadowColor = arrowC;
    octx.shadowBlur = 10;
    octx.beginPath();
    octx.moveTo(14, 0);
    octx.lineTo(-8, -8);
    octx.lineTo(-4, 0);
    octx.lineTo(-8, 8);
    octx.closePath();
    octx.fill();
    octx.restore();
  }

  // event banner — sits BELOW the HUD's clock/kill-counter block, and follows
  // the DOM UI's --ui-scale so it stays clear of the (zoomed) HUD and keeps
  // its proportions on high-res displays (the canvas itself is never zoomed)
  if (eng.banner) {
    const b = eng.banner;
    const a = Math.min(1, b.life, (b.maxLife - b.life) * 3);
    const uiS = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const bSize = (b.size || 24) * uiS;
    octx.save();
    octx.globalAlpha = a;
    octx.textAlign = 'center';
    // event banners speak in the UI's engraved display face
    octx.font = `700 ${bSize}px Cinzel, 'Palatino Linotype', serif`;
    // tracked capitals, where the engine supports it (reset by restore())
    try { (octx as unknown as { letterSpacing: string }).letterSpacing = '0.12em'; } catch { /* older engines */ }
    octx.fillStyle = b.color;
    octx.shadowColor = b.color;
    octx.shadowBlur = (18 + (b.size > 24 ? 14 : 0)) * uiS;
    octx.fillText(b.str, w / 2, (176 + ((b.size || 24) - 24) * 0.6) * uiS);
    octx.restore();
  }

  if (eng.flash) {
    octx.fillStyle = `rgba(${eng.flash.color},${Math.max(0, eng.flash.a)})`;
    octx.fillRect(0, 0, w, h);
  }

  // perf overlay always sits on the topmost 2D layer
  eng.perf.draw(octx, w);
}

// ==================================================== zone / beam / bolt SDFs
// Each spell zone becomes a few analytic shape instances. The SDF math gives
// mathematically-crisp rings with true exponential glow falloff at any radius
// — no baked-stroke blurring — and the bloom pass lights them up.

function emitZone(sh: ShapeList, q: QuadList, eng: Engine, z: Zone, alpha: number, camX: number, camY: number, lanternDim = 1) {
  const cam = eng.cam;
  const vt = eng.vt;
  const zx = lerp(z.px, z.x, alpha), zy = lerp(z.py, z.y, alpha);
  const zr = lerp(z.pr, z.r, alpha);
  const x = zx - camX, y = zy - camY;
  const m = zr + 60;
  if (x < -m || y < -m || x > cam.w + m || y > cam.h + m) return;

  // life ticks down on the 60Hz sim clock; interpolate it onto the render
  // clock like positions, or growth/fade animations step visibly at 120Hz+
  // (the sigil's charge-up ring was the worst offender).
  const lifeI = Math.min(z.maxLife, z.life + (1 - alpha) * STEP);

  if (z.kind === 'frostwave') {
    // Frostbloom: a CRYSTALLINE wavefront — thin hard ice line, frozen-air
    // veil left in its wake, and ice crystals riding the rim. Deliberately
    // sharp and glassy where Twilight Nova is soft and shadowed.
    const t = Math.max(0, lifeI / z.maxLife);
    sh.push(SHAPE_RING, x, y, 0, zr, 2.2, 8, 0, 0.92, 0.98, 1, t, 0.15 * t, 0.32 * t, 0.44 * t);
    // frozen air filling the bloomed area, fading with the wave
    sh.push(SHAPE_DISC, x, y, 0, zr * 0.97, 0.75, 0.6, 0, 0.35, 0.62, 0.80, 0.09 * t, 0.18, 0.38, 0.52);
    const shardE = q.uv('p:shard')!;
    for (let i = 0; i < 9; i++) {
      const a = z.seed + (i / 9) * TAU;
      const wob = Math.sin(vt * 4 + i * 1.7);
      const cr = zr - 4 - Math.abs(wob) * 3;
      q.push(true, shardE, x + Math.cos(a) * cr, y + Math.sin(a) * cr, 7 + (i % 3) * 2.5, a + Math.PI / 2, t * 0.9, 0.75, 0.93, 1, 1);
    }
  } else if (z.kind === 'rift') {
    const fade = Math.max(0, Math.min(1, lifeI * 2, (z.maxLife - lifeI) * 3));
    // dark maw (alpha-blended so it swallows the sky beneath)
    sh.push(SHAPE_DISC, x, y, 0, zr, 0.55, 1.1, 0, 0.030, 0.012, 0.085, 0.92 * fade, 0.14, 0.055, 0.26, false);
    // three spiral arms twisting into the core
    sh.push(SHAPE_SPIRAL, x, y, z.spin, zr * 0.97, 3, -2.74, 5.5, 0.62, 0.37, 1, 0.85 * fade, 0.24, 0.13, 0.42);
    // pulsing event-horizon ring
    const hr = zr * 0.32 + Math.sin(vt * 6) * 2;
    sh.push(SHAPE_RING, x, y, 0, hr, 1.7, 7, 0, 1, 0.60, 0.84, 0.9 * fade, 0.30, 0.14, 0.24);
  } else if (z.kind === 'nebula') {
    // a soft violet body with living colour lobes — all soft edges, no
    // outlines (they broke the dream theme)
    const fade = Math.max(0, Math.min(1, lifeI * 1.5, (z.maxLife - lifeI) * 2)) * 0.8;
    sh.push(SHAPE_DISC, x, y, 0, zr, 0.72, 0.55, 0, 0.62, 0.43, 0.90, 0.30 * fade, 0.50, 0.33, 0.80);
    // slow internal lobes give the cloud living depth
    for (let i = 0; i < 3; i++) {
      const aa = z.seed + i * 2.1 + vt * 0.3;
      const lx = x + Math.cos(aa) * zr * 0.28;
      const ly = y + Math.sin(aa) * zr * 0.28;
      const lr = zr * (0.55 + 0.08 * Math.sin(vt * 1.4 + i * 2));
      const lc: [number, number, number] = i === 0 ? [0.77, 0.55, 1] : i === 1 ? [1, 0.60, 0.84] : [0.54, 0.48, 1];
      sh.push(SHAPE_DISC, lx, ly, 0, lr, 0.8, 0.8, 0, lc[0], lc[1], lc[2], 0.22 * fade, lc[0] * 0.5, lc[1] * 0.5, lc[2] * 0.5);
    }
  } else if (z.kind === 'sigil') {
    const f = Math.max(0, 1 - lifeI / z.maxLife);
    // accelerating pulse via accumulated PHASE (vt·6 + f²·26), never via
    // frequency × absolute time: sin(vt·(6+f·18)) chirps — late-run vt is huge,
    // so each tiny growth of f slewed the phase by dozens of radians per frame
    // and the rim flickered like noise (read as stuttering expansion)
    const pulse = 0.5 + 0.5 * Math.sin(vt * 6 + f * f * 26);
    const aa = 0.5 + Math.max(0, Math.min(1, f)) * 0.5;
    const sigR = zr * (0.4 + f * 0.6);
    // charging golden circle
    sh.push(SHAPE_RING, x, y, 0, sigR, 2, 9 + pulse * 5, 0, 1, 0.82, 0.48, aa, 0.38 + pulse * 0.2, 0.28 + pulse * 0.14, 0.12);
    // rotating rune triangle inscribed at zr*0.45
    const rr = zr * 0.45 * (0.4 + f * 0.6);
    const rot = vt * 1.5;
    for (let k = 0; k < 3; k++) {
      const a0 = rot + (k / 3) * TAU - Math.PI / 2;
      const a1 = rot + ((k + 1) / 3) * TAU - Math.PI / 2;
      const x0 = x + Math.cos(a0) * rr, y0 = y + Math.sin(a0) * rr;
      const segA = Math.atan2(Math.sin(a1) * rr - Math.sin(a0) * rr, Math.cos(a1) * rr - Math.cos(a0) * rr);
      const segL = 2 * rr * Math.sin(Math.PI / 3);
      sh.push(SHAPE_CAPSULE, x0, y0, segA, segL, 1.2, 4, 0, 0.71, 0.55, 1, aa * 0.9, 0.18, 0.12, 0.30);
    }
    // small centre arc glyph (gap faces the spin)
    sh.push(SHAPE_RING, x, y, rot + Math.PI, 7, 1.2, 3.5, Math.PI - 0.6, 1, 0.95, 0.80, aa, 0.25, 0.22, 0.15);
  } else if (z.kind === 'scorch') {
    const fade = Math.max(0, Math.min(1, lifeI * 1.2, (z.maxLife - lifeI) * 4));
    const flick = 0.85 + 0.15 * Math.sin(vt * 9 + z.seed);
    const [r1, g1, b1] = rgb(z.c1);
    const [r2, g2, b2] = rgb(z.c2);
    sh.push(SHAPE_DISC, x, y, 0, zr, 0.7, 0.9, 0, r1, g1, b1, 0.17 * fade * flick, r2 * 0.7, g2 * 0.7, b2 * 0.7);
  } else if (z.kind === 'novawave') {
    if (z.delay && z.delay > 0) return;
    // Twilight Nova: DUSK ITSELF sweeps outward — a wide band of deepening
    // night trailing the wave (alpha-blended, it darkens what it crosses),
    // crowned by a warm pink twilight rim with the first stars twinkling in
    // its wake. Soft and shadowed where Frostbloom is sharp and glassy.
    const t = Math.max(0, Math.min(1, lifeI / z.maxLife));
    // the shadow hugs the wavefront and stays faint: repeated casts stack
    // concentric bands, so anything stronger washes the whole screen violet
    sh.push(SHAPE_RING, x, y, 0, zr * 0.88, zr * 0.11, 1, 0, 0.055, 0.025, 0.10, 0.20 * t, 0, 0, 0, false);
    sh.push(SHAPE_RING, x, y, 0, zr, 4.5, 15, 0, 1, 0.62, 0.85, 0.9 * t, 0.30 * t, 0.11 * t, 0.24 * t);
    const starE = q.uv('p:star')!;
    for (let i = 0; i < 6; i++) {
      const a = z.seed + (i / 6) * TAU + vt * 0.35;
      const tw = 0.5 + 0.5 * Math.sin(vt * 7 + i * 2.4);
      const sr = zr * (0.78 + 0.14 * Math.sin(i * 4.1));
      q.push(true, starE, x + Math.cos(a) * sr, y + Math.sin(a) * sr, 5.5 + tw * 4, a, t * (0.35 + 0.6 * tw), 1, 0.74, 0.90, 1);
    }
  } else if (z.kind === 'lantern') {
    // Soul Lantern: the blessed ground is nearly invisible as light — a
    // barely-there wash further dimmed as the Procession stacks lanterns
    // (alpha layers compound, so per-instance alpha alone can never stay
    // calm). Extent is told by drifting will-o'-wisps instead of any fill
    // or outline; identity lives in the little lantern and its spirits.
    const fade = Math.max(0, Math.min(1, lifeI * 2, (z.maxLife - lifeI) * 4));
    const breath = 0.5 + 0.5 * Math.sin(z.ph * 0.9);
    sh.push(SHAPE_DISC, x, y, 0, zr, 0.55, 1.9, 0, 0.26, 0.55, 0.50, fade * (0.038 + breath * 0.012) * lanternDim, 0.08, 0.19, 0.17, false);
    const glowE = q.uv('glow')!;
    // will-o'-wisps wandering the blessed ground (deterministic per zone seed)
    const wispA = fade * (0.5 + 0.5 * lanternDim);
    for (let i = 0; i < 5; i++) {
      const h1 = Math.sin(z.seed * 7.3 + i * 12.9) * 0.5 + 0.5;
      const h2 = Math.sin(z.seed * 3.1 + i * 5.7) * 0.5 + 0.5;
      const wa = h1 * TAU + vt * (0.15 + h2 * 0.2);
      const wr = zr * (0.3 + 0.6 * h2);
      const tw = 0.5 + 0.5 * Math.sin(vt * (1.1 + h1) + i * 2.1);
      q.push(true, glowE, x + Math.cos(wa) * wr, y + Math.sin(wa) * wr - 6 - tw * 5, 3 + tw * 2.5, 0, wispA * (0.10 + 0.24 * tw), 0.55, 0.95, 0.85, 1);
    }
    // floating lantern: small warm halo + body + glass flame
    const sway = Math.sin(z.ph) * 3;
    const ly = y - 26 + Math.sin(z.ph * 0.7) * 2;
    const flick = 0.95 + Math.sin(z.ph * 2.6) * 0.04 + breath * 0.06;
    q.push(true, glowE, x + sway, ly, 10 * flick, 0, fade * 0.38, 0.66, 1, 0.91, 1);
    const lantE = q.uv('lantern')!;
    q.push(false, lantE, x + sway, ly, lantE.half, 0, fade);
    q.push(true, glowE, x + sway, ly, 4.5 + Math.sin(z.ph * 5) * 1.2, 0, fade * 0.7, 0.29, 0.85, 0.77, 1);
    // spirits rising from the flame
    if (Math.random() < 0.03) {
      eng.particles.spawn({
        x: zx + sway + (Math.random() * 14 - 7), y: zy - 22 - Math.random() * 8,
        vx: Math.random() * 10 - 5, vy: -14 - Math.random() * 12,
        life: 0.9 + Math.random() * 0.7, size: 1.5 + Math.random() * 1.6,
        color: '#a8ffe8', mode: 'glow', drag: 0.98,
      });
    }
  }
}

function emitBeam(sh: ShapeList, eng: Engine, b: Beam, alpha: number, camX: number, camY: number) {
  const t = Math.max(0, Math.min(1, (b.life + (1 - alpha) * STEP) / b.maxLife));
  const x = b.x - camX, y = b.y - camY;
  const a = lerp(b.pa, b.a, alpha);
  const wNow = b.w * (0.4 + 0.6 * Math.sin(t * Math.PI));
  // radiant lance, two layers like the Canvas2D original: a translucent body
  // whose bright extent sits at the collision half-width (w/2) so what you see
  // is what hits, plus a thin hot core. Alphas stay modest so enemies under
  // several stacked lances remain readable.
  sh.push(SHAPE_CAPSULE, x, y, a, b.len, wNow * 0.5, wNow * 0.4, 0, 1, 0.99, 0.95, 0.27 * t + 0.05, 0.36 * t, 0.38 * t, 0.48 * t);
  sh.push(SHAPE_CAPSULE, x, y, a, b.len, wNow * 0.16, wNow * 0.22, 0, 1, 0.99, 0.92, 0.50 * t + 0.04, 0.46 * t, 0.38 * t, 0.22 * t);
  // origin crescent: fades + expands as the lance dissipates
  const cf = t;
  const cr = 18 + (1 - cf) * 10;
  const gap = 0.6 + (1 - cf) * 0.5;
  sh.push(SHAPE_RING, x, y, a + Math.PI, cr, 1.6 * (0.4 + 0.6 * cf), 8 * cf + 1, Math.PI - gap, 1, 0.95, 0.72, cf, 0.5 * cf, 0.44 * cf, 0.22 * cf);
}

function emitBolt(sh: ShapeList, b: Bolt, alpha: number, camX: number, camY: number) {
  const t = Math.max(0, Math.min(1, (b.life + (1 - alpha) * STEP) / b.maxLife));
  // jagged capsule segments with a hot white core and electric blue glow —
  // the bloom pass gives the strike its flash
  for (let i = 0; i < b.n - 1; i++) {
    const x0 = b.ptsX[i] - camX, y0 = b.ptsY[i] - camY;
    const x1 = b.ptsX[i + 1] - camX, y1 = b.ptsY[i + 1] - camY;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    sh.push(SHAPE_CAPSULE, x0, y0, Math.atan2(dy, dx), len, 1.6, 7, 0, 1, 1, 1, t, 0.30 * t, 0.55 * t, 0.75 * t);
  }
}

// ==================================================== quad emitters
// Each translates an entity into instanced atlas quads. Motions that were
// live in the Canvas2D era (rotation, bob, tint) are per-instance params.

const FROZEN_TINT: [number, number, number] = [0.72, 0.89, 1];

function emitEnemy(q: QuadList, shOver: ShapeList, eng: Engine, e: Enemy, alpha: number, camX: number, camY: number) {
  const cam = eng.cam;
  const vt = eng.vt;
  const ix = lerp(e.px, e.x, alpha), iy = lerp(e.py, e.y, alpha);
  let x = ix - camX, y = iy - camY;

  // ---- blink choreography (the Shade boss) --------------------------------
  // Wind-up: the body folds into a thin vertical seam of night (width and
  // alpha collapse, height holds via aspect) while a closing iris marks the
  // exit. Unfold: the same seam opens back into the body at the far end.
  // Emitted BEFORE the cull so the exit telegraph draws even when the body
  // waits offscreen. All of it reads bossFire countdowns — no render state.
  let bodyA = 1, bodyS = 1, bodyAsp = 1;
  const bfb = e.boss ? e.bossFire : null;
  if (bfb && (bfb.blinkT > 0 || bfb.blinkIn > 0)) {
    const [br, bg, bb] = rgb(e.color);
    let seam: number;
    if (bfb.blinkT > 0) {
      const f = clamp(1 - bfb.blinkT / bfb.blinkDur, 0, 1); // 0 -> 1 folding
      const g = f * f;
      bodyA = 1 - g * 0.92; bodyS = 1 - g * 0.5; bodyAsp = 1 + g * 2.2;
      seam = f;
      // the exit: a night iris closing on the point it will step from,
      // counter-rotating arcs so the eye reads motion toward the centre
      const ex = bfb.bx - camX, ey = bfb.by - camY;
      const R = e.radius * (0.8 + 1.9 * (1 - g));
      shOver.push(SHAPE_RING, ex, ey, vt * 2.2, R, 1.6, 7, 0.5, br, bg, bb, 0.5 + 0.45 * f, br * 0.5, bg * 0.5, bb * 0.6);
      shOver.push(SHAPE_RING, ex, ey, -vt * 3.4 + 1.7, R * 0.66, 1.2, 5, 0.95, 1, 1, 1, 0.3 + 0.4 * f, br * 0.4, bg * 0.4, bb * 0.5);
      shOver.push(SHAPE_DISC, ex, ey, 0, e.radius * (0.5 + f * 0.6), 0.5, 1.4, 0, br, bg, bb, 0.06 + 0.3 * f, br * 0.5, bg * 0.5, bb * 0.6);
    } else {
      const g = (bfb.blinkIn / BLINK_IN) ** 2;              // 1 -> 0 unfolding
      // tiny overshoot as it lands so the arrival has a pop, not a fade-in
      bodyA = 1 - g * 0.9;
      bodyS = 1 - g * 0.5 + Math.sin((1 - g) * Math.PI) * 0.07;
      bodyAsp = 1 + g * 2.2;
      seam = g;
    }
    if (seam > 0.04) {
      // the seam itself: a razor of violet light the body threads through
      const hgt = e.radius * (2.4 + seam * 1.4);
      shOver.push(SHAPE_CAPSULE, x, y - hgt / 2, Math.PI / 2, hgt, 1 + seam * 1.6, 2 + 9 * seam, 0, 1, 0.96, 1, 0.75 * seam, br * 1.1, bg * 1.1, bb * 1.3);
    }
  }

  // cull margin scales with the sprite: art extends to roughly 2× the collision
  // radius, so a boss needs far more than a fixed margin or it pops at edges.
  const cullM = Math.max(90, e.radius * 2 + 40);
  if (x < -cullM || y < -cullM || x > cam.w + cullM || y > cam.h + cullM) return;

  // melee strike lunge: the whole body snaps toward the player then eases back
  let strikePhase = 0, strikeAng = 0;
  if (e.meleeAnim > 0) {
    strikePhase = Math.min(1, e.meleeAnim / MELEE_ANIM_DUR);
    strikeAng = Math.atan2(eng.player.y + PLAYER_HURT_DY - iy, eng.player.x - ix);
    const pop = Math.sin(strikePhase * Math.PI) * (0.6 + 0.4 * Math.sqrt(strikePhase));
    const lunge = (e.radius * 0.7 + 12) * pop;
    x += Math.cos(strikeAng) * lunge;
    y += Math.sin(strikeAng) * lunge;
  }

  const glowE = q.uv('glow')!;
  // soft ground shadow (the Canvas2D era had one; the GPU port lost it)
  q.push(false, glowE, x, y + e.radius * 0.55, e.radius * 1.05 * bodyS, 0, 0.38 * bodyA, 0.01, 0.005, 0.03, 1, 0.34);

  // smooth hit-flash fade + freeze tint via per-instance shader mix
  const flashMix = e.hitFlash > 0 ? Math.min(1, e.hitFlash / 0.12) * 0.85 : 0;
  const frozen = e.slowT > 0 && flashMix === 0;
  const tr = frozen ? FROZEN_TINT[0] : 1, tg = frozen ? FROZEN_TINT[1] : 1, tb = frozen ? FROZEN_TINT[2] : 1;
  const mix = flashMix > 0 ? flashMix : frozen ? 0.55 : 0;

  const anim = ENEMY_ANIM[e.type];
  // bosses wear their archetype's own body (Devourer eye, Colossus golem,
  // Choir siren), scaled up from the base sprite by their radius
  const type = e.type;
  const sc = e.radius / ENEMY_TYPES[e.type].radius;
  const bob = anim.bob(e.animT);
  let fi = ((e.animT * anim.rate + e.seed) / TAU * FRAMES) | 0;
  fi = ((fi % FRAMES) + FRAMES) % FRAMES;
  const entry = q.uv(enemyFrameId(type, fi));
  if (!entry) return;
  const half = entry.half * sc;
  // eye tentacle crown: emitted UNDER the body as one live, continuously
  // rotating quad — smooth at any scale (this fixed the boss's choppiness)
  if (e.type === 'eye') {
    const tentE = q.uv('tentacles');
    if (tentE) {
      const hover = Math.sin(e.animT * 3 + e.seed) * 3 * sc;
      const spin = e.animT * 0.4 + e.seed;
      q.push(false, tentE, x, y + bob * sc + hover, tentE.half * sc, spin, 1, tr, tg, tb, mix);
      drawStats.enemyLiveOps++;
    }
  }
  q.push(false, entry, x, y + bob * sc, half * bodyS, 0, bodyA, tr, tg, tb, mix, bodyAsp);
  drawStats.enemyBlits++;

  // ---- live overlays as extra quads (smooth, on the global clock) ----
  if (e.golden) {
    const ringE = q.uv('ring')!;
    const gr = e.radius + 8 + Math.sin(vt * 4) * 2;
    q.push(true, ringE, x, y, gr / 30 * ringE.half, 0, 0.8, 1, 0.82, 0.48, 1);
    drawStats.enemyLiveOps++;
  } else if (e.elite) {
    // crimson corona ring + 4 orbiting thorn shards
    const ringE = q.uv('ring')!;
    const coronaR = e.radius + 11 + Math.sin(vt * 5) * 2;
    q.push(true, ringE, x, y, coronaR / 30 * ringE.half, 0, 0.85, 1, 0.35, 0.48, 1);
    const shE = q.uv('shard')!;
    for (let i = 0; i < 4; i++) {
      const sa = vt * 1.8 + (i / 4) * TAU;
      const R = e.radius + 15;
      q.push(false, shE, x + Math.cos(sa) * R, y + Math.sin(sa) * R, shE.half * 0.9, sa + Math.PI / 2, 1, 1, 0.35, 0.48, 0.85);
    }
    drawStats.enemyLiveOps++;
  } else if (e.boss) {
    // every nightmare wears a slow corona in its own colour so it reads as a
    // boss whatever body it took
    const ringE = q.uv('ring')!;
    const [br, bg, bb] = rgb(e.color);
    const coronaR = e.radius + 16 + Math.sin(vt * 3) * 4;
    q.push(true, ringE, x, y, coronaR / 30 * ringE.half, 0, 0.6 * bodyA, br, bg, bb, 1);
    drawStats.enemyLiveOps++;
  }

  // resonance marks — cheap live overlays so combos read at a glance:
  // charge = white-blue crackle flicker, brand = a steady golden halo
  if (e.chargeT > 0) {
    const flick = 0.5 + 0.5 * Math.sin(vt * 22 + e.seed);
    q.push(true, glowE, x, y - e.radius * 0.3, e.radius * 0.8 + 5, 0, 0.22 + 0.3 * flick, 0.72, 0.9, 1, 1);
    drawStats.enemyLiveOps++;
  }
  if (e.brandT > 0) {
    const ringE = q.uv('ring')!;
    const brR = e.radius + 6 + Math.sin(vt * 6 + e.seed) * 1.5;
    q.push(true, ringE, x, y, brR / 30 * ringE.half, 0, 0.55, 1, 0.92, 0.6, 1);
    drawStats.enemyLiveOps++;
  }
  // golem: orbiting rock chunks (live quads, smooth)
  if (e.type === 'golem') {
    const rockE = q.uv('rock')!;
    for (let i = 0; i < 4; i++) {
      const ra = vt * 1.2 + (i / 4) * TAU;
      const R = (26 + Math.sin(vt * 3 + i) * 2) * sc;
      const rx = x + Math.cos(ra) * R;
      const ry = y + bob * sc + Math.sin(ra) * R * 0.5 - 6 * sc;
      q.push(false, rockE, rx, ry, rockE.half * sc, ra, 1, mix > 0 ? tr : 0.23, mix > 0 ? tg : 0.37, mix > 0 ? tb : 0.54, 1);
    }
    drawStats.enemyLiveOps++;
  }
  // warlock: orbiting charge-orbs brighten as the volley nears (live additive)
  if (e.type === 'warlock') {
    const orbE = q.uv('orb')!;
    const charge = e.ranged ? clamp(1 - e.shootCd / 1.2, 0, 1) : 0;
    for (let i = 0; i < 3; i++) {
      const oa = vt * 2.4 + (i / 3) * TAU;
      const ox = x + Math.cos(oa) * 17 * sc;
      const oy = y + bob * sc + Math.sin(oa) * 8 * sc - 22 * sc;
      q.push(true, orbE, ox, oy, (5 + charge * 4) * sc, 0, 0.65 + charge * 0.35);
    }
    drawStats.enemyLiveOps++;
  }
  // siren: charging mouth-glow + spark motes (baked frames are at rest)
  // (boss sirens never fire this volley — bossFire replaces it — so the
  // charge glow must not read their frozen shootCd)
  if (e.type === 'siren' && !e.boss && e.ranged && e.shootCd < 0.6) {
    const hover = Math.sin(e.animT * 4 + e.seed) * 3 * sc;
    const gy = y + bob * sc + hover - 2 * sc;
    q.push(true, glowE, x, gy, (10 + Math.sin(vt * 20) * 3) * sc, 0, 0.75, 0.49, 0.79, 1, 1);
    q.push(true, glowE, x, gy, 3.5 * sc, 0, 0.95, 0.92, 0.97, 1, 1);
    if (Math.random() < 0.4) {
      const a = Math.atan2(eng.player.y - e.y, eng.player.x - e.x);
      eng.particles.spawn({ x: e.x, y: e.y - 4, vx: Math.cos(a) * 40 + (Math.random() * 30 - 15), vy: Math.sin(a) * 40 - 20, life: 0.5, size: 1.5 + Math.random() * 1.5, color: '#7dc9ff', mode: 'glow', drag: 0.95 });
    }
    drawStats.enemyLiveOps++;
  }
  // eye iris tracks the player (baked eyeball omits it)
  if (e.type === 'eye') {
    const hover = Math.sin(e.animT * 3 + e.seed) * 3 * sc;
    const a = Math.atan2(eng.player.y - e.y, eng.player.x - e.x);
    const cy = y + bob * sc + hover;
    const irisE = q.uv('iris')!;
    q.push(false, irisE, x, cy, irisE.half * sc, a, 1, tr, tg, tb, mix);
    drawStats.enemyLiveOps++;
    // boss: orbiting crown of shards on the global clock
    if (e.boss) {
      const shE = q.uv('shard')!;
      for (let i = 0; i < 6; i++) {
        const sa = (i / 6) * TAU + vt * 0.8;
        const R = (30 + Math.sin(vt * 2 + i) * 3) * sc;
        const sx = x + Math.cos(sa) * R;
        const sy = cy + Math.sin(sa) * R * 0.6 - 14 * sc;
        q.push(false, shE, sx, sy, shE.half * sc, sa, 1);
      }
      drawStats.enemyLiveOps++;
    }
  }

  // melee slash: bright white-cored crescent sweeping toward the player.
  // Drawn on the OVER shape pass so it always reads, whatever it crosses.
  if (strikePhase > 0) {
    const f = strikePhase;                 // 1 -> 0
    const grow = 1 - f;                    // 0 -> 1: the arc flies outward
    const reach = e.radius + e.meleeReach;
    const cx = x + Math.cos(strikeAng) * (e.radius * 0.4 + reach * grow);
    const cy = y + Math.sin(strikeAng) * (e.radius * 0.4 + reach * grow);
    const arcR = e.radius * 0.9 + e.meleeReach * 0.8;
    const halfArc = 1.15 * (0.5 + 0.5 * f);
    const [er, eg, eb] = rgb(e.color);
    shOver.push(SHAPE_RING, cx, cy, strikeAng, arcR, 2.6, 7, halfArc, 1, 1, 1, f, er * 0.9 * f, eg * 0.9 * f, eb * 0.9 * f);
    if (f > 0.5) {
      const ff = (f - 0.5) * 2;
      shOver.push(SHAPE_DISC, x + Math.cos(strikeAng) * reach, y + Math.sin(strikeAng) * reach, 0, 14 * ff, 0.4, 1.2, 0, 1, 1, 1, ff, er, eg, eb);
    }
  }
}

// ---------------------------------------------------------------- player
// The wizard is a baked sprite sheet like the enemies: hem ripple + hat bend
// in the frames; bob, sway, facing (UV mirror), i-frame blink and the staff
// orb applied live. Emitted before enemies so the swarm overlaps him (same
// stacking the game always had).
function emitPlayer(q: QuadList, eng: Engine, x: number, y: number) {
  const p = eng.player;
  const vt = eng.vt;
  const bob = Math.sin(p.animT * 6) * (p.moving ? 3 : 1.4);
  const sway = Math.sin(p.animT * 6 + 1) * (p.moving ? 0.08 : 0.03);
  const blink = (p.iframes > 0 || p.invuln > 0) && Math.sin(vt * 40) > 0;
  const alpha = blink ? 0.45 : 1;
  const glowE = q.uv('glow')!;
  // ground shadow
  q.push(false, glowE, x, y + 8, 21, 0, 0.4, 0.01, 0.005, 0.03, 1, 0.32);
  // body
  let fi = ((p.animT * 8) / TAU * FRAMES) | 0;
  fi = ((fi % FRAMES) + FRAMES) % FRAMES;
  const wizE = q.uv(wizardFrameId(fi));
  if (!wizE) return;
  const mirrored = p.facing < 0;
  q.push(false, wizE, x, y - WIZARD_CY - bob, wizE.half, mirrored ? -sway : sway, alpha, 1, 1, 1, 0, 1, mirrored);
  // staff orb: pulsing beacon that flares on casts (castPulse)
  const pulse = 5 + Math.sin(vt * 5) * 1.2 + p.castPulse * 6;
  const ox = x + 14 * p.facing;
  const oy = y - 48 - bob;
  q.push(true, glowE, ox, oy, pulse * 2.6, 0, 0.9 * alpha, 0.50, 0.96, 1, 1);
  q.push(true, glowE, ox, oy, pulse * 1.05, 0, alpha, 0.94, 1, 1, 1);
}

function emitGem(q: QuadList, cam: Engine['cam'], g: Gem, alpha: number, camX: number, camY: number) {
  const gx = lerp(g.px, g.x, alpha), gy = lerp(g.py, g.y, alpha);
  const x = gx - camX, y = gy - camY + Math.sin(g.ph) * 3;
  if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) return;
  const id = g.shard ? 'gem:big' : g.merged ? 'gem:merged' : g.heal ? 'gem:heal' : g.big ? 'gem:big' : 'gem:xp';
  const e = q.uv(id);
  if (!e) return;
  const rot = g.ph * 0.5;
  if (g.shard) {
    // nightmare shard: reuse big-gem sprite tinted crimson
    q.push(false, e, x, y, e.half, rot, 1, 1, 0.35, 0.48, 0.6);
  } else {
    q.push(false, e, x, y, e.half, rot, 1);
  }
}

function emitPickup(q: QuadList, eng: Engine, s: Pickup, camX: number, camY: number) {
  const cam = eng.cam;
  const x = s.x - camX, y = s.y - camY;
  if (x < -60 || y < -60 || x > cam.w + 60 || y > cam.h + 60) return;
  const urgent = s.life < 5 ? 0.5 + 0.5 * Math.sin(eng.vt * 10) : 1;
  const glowE = q.uv('glow')!;
  const beaconE = q.uv('pickup:beacon')!;
  const ringE = q.uv('ring')!;
  const starE = q.uv('pickup:star')!;
  if (s.kind === 'altar') {
    // a whispering altar: violet beacon, slow rune wheel, embers of the bargain
    q.push(true, beaconE, x, y, beaconE.half, 0, urgent * 0.9, 0.77, 0.55, 1, 1);
    const ringPulse = 0.9 + Math.sin(s.ph * 0.8) * 0.15;
    q.push(true, ringE, x, y + 6, 14 * ringPulse, 0, 0.55 * urgent, 0.77, 0.55, 1, 1);
    q.push(true, glowE, x, y - 10, 30, 0, 0.8 * urgent, 0.6, 0.36, 1, 1);
    const runeE = q.uv('p:rune0')!;
    for (let i = 0; i < 3; i++) {
      const ra = s.ph * 0.5 + (i / 3) * TAU;
      q.push(true, runeE, x + Math.cos(ra) * 20, y - 12 + Math.sin(ra) * 9, 7, ra, 0.85 * urgent, 0.9, 0.7, 1, 1);
    }
    return;
  }
  // vertical beacon rising from the star
  q.push(true, beaconE, x, y, beaconE.half, 0, urgent, 0.5, 0.96, 1, 1);
  // pulsing ground ring where the star rests (cyan, additive)
  const ringPulse = 0.9 + Math.sin(s.ph) * 0.12;
  q.push(true, ringE, x, y + 6, 11 * ringPulse, 0, 0.5 * urgent, 0.5, 0.96, 1, 1);
  // soft glow halo + spinning five-point star core, both cyan
  q.push(true, glowE, x, y - 8, 26, 0, urgent, 0.5, 0.96, 1, 1);
  q.push(true, starE, x, y - 8, starE.half, s.ph * 0.6, urgent);
}

function emitOrbitals(q: QuadList, eng: Engine, alpha: number, camX: number, camY: number) {
  if (!eng.orbitals.length) return;
  const glowE = q.uv('glow')!;
  const petalE = q.uv('petal')!;
  for (const o of eng.orbitals) {
    const x = lerp(o.px, o.x, alpha) - camX, y = lerp(o.py, o.y, alpha) - camY;
    q.push(true, glowE, x, y, 14, 0, 0.8, 0.49, 1, 0.69, 1);     // green glow halo
    q.push(false, petalE, x, y, petalE.half, o.a * 2, 1);         // spinning blossom
  }
}

function emitProjectile(q: QuadList, eng: Engine, pr: Projectile, alpha: number, camX: number, camY: number) {
  const cam = eng.cam;
  const ix = lerp(pr.px, pr.x, alpha), iy = lerp(pr.py, pr.y, alpha);
  const x = ix - camX, y = iy - camY;
  if (x < -80 || y < -80 || x > cam.w + 80 || y > cam.h + 80) return;
  if (pr.kind === 'arcane') {
    const e = q.uv('proj:arcane')!;
    q.push(true, e, x, y, e.half, Math.atan2(pr.vy, pr.vx), 1);
  } else if (pr.kind === 'ember') {
    const e = q.uv('proj:ember')!;
    q.push(true, e, x, y, e.half, 0, 1);
  } else if (pr.kind === 'comet') {
    // landing marker: a soft contracting ring where the star will strike
    const f = Math.min(1, pr.t / pr.dur);
    const mx = pr.tx - camX, my = pr.ty - camY;
    const ringE = q.uv('ring')!;
    q.push(true, ringE, mx, my, (26 - f * 14) / 30 * ringE.half, 0, 0.25 + f * 0.45, 1, 0.70, 0.95, 1);
    const glowE = q.uv('glow')!;
    const a = Math.atan2(pr.ty - iy || 1, pr.tx - ix || 0.4);
    // comet trail: stretched spark streak behind the head
    const sparkE = q.uv('p:spark')!;
    q.push(true, sparkE, x - Math.cos(a) * 28, y - Math.sin(a) * 28, 42, a, 0.6, 0.66, 0.55, 1, 1, 0.22);
    const e = q.uv('proj:arcane')!; // pink-tinted round head
    q.push(true, e, x, y, 15, a, 1, 1, 0.7, 0.95, 1);
    q.push(true, glowE, x, y, 19, 0, 0.4, 1, 0.70, 0.95, 1);
  } else if (pr.kind === 'fang') {
    const e = q.uv('proj:fang')!;
    // art baked for the base hitbox (r=12); Maw of Night grows pr.r, so the
    // crescent must grow with it or the hitbox outruns the visual
    q.push(false, e, x, y, e.half * (pr.r / 12), Math.atan2(pr.vy, pr.vx), 1);
  } else if (pr.kind === 'glaive') {
    // subtle icy halo kept small so the blade silhouette reads as a glaive
    const glowE = q.uv('glow')!;
    q.push(true, glowE, x, y, 21, 0, 0.28, 0.62, 0.85, 1);
    const e = q.uv('proj:glaive')!; // baked twin-bladed star-blade, spinning
    // drawn slightly under natural size: blade tips at ~23px sit closer to the
    // effective reach (r=14 + enemy radius) — full size read as misses; any
    // smaller and it blurs together with Arcane Missiles
    q.push(false, e, x, y, e.half * 0.78, pr.spin, 1);
    q.push(true, e, x, y, e.half * 0.78, pr.spin, 0.18); // faint additive glint on the edge
  }
}

function emitBossProjectile(q: QuadList, sh: ShapeList, eng: Engine, bp: BossProjectile, alpha: number, camX: number, camY: number) {
  if (bp.life <= 0) return;
  const cam = eng.cam;
  const ix = lerp(bp.px, bp.x, alpha), iy = lerp(bp.py, bp.y, alpha);
  const x = ix - camX, y = iy - camY;
  if (x < -40 || y < -40 || x > cam.w + 40 || y > cam.h + 40) return;
  const s = bp.r / 6;
  const pulse = 0.85 + 0.15 * Math.sin(eng.vt * 12 + (bp.x + bp.y) * 0.05);
  // velocity trail (was Canvas2D-only; capsule shape brings it back)
  const sp = Math.hypot(bp.vx, bp.vy) || 1;
  const tl = Math.min(26, sp * 0.045) * s;
  if (tl > 4) {
    sh.push(SHAPE_CAPSULE, x - (bp.vx / sp) * tl, y - (bp.vy / sp) * tl, Math.atan2(bp.vy, bp.vx), tl, 1.4 * s, 4 * s, 0, 1, 0.35, 0.39, 0.5, 0.4, 0.10, 0.11);
  }
  const glowE = q.uv('glow')!;
  q.push(true, glowE, x, y, 22 * s * pulse, 0, 0.9, 1, 0.4, 0.44, 1); // hot red halo
  const e = q.uv('proj:bullet')!;
  q.push(false, e, x, y, e.half * s, Math.atan2(bp.vy, bp.vx), 1);
}

// ---------------------------------------------------------------- particles
// Every particle mode maps to a real atlas sprite now — the WebGL-era "all
// particles are round glows" approximation is gone. Sparks stretch along
// their velocity; runes/stars/shards/petals spin; rings expand.
function emitParticles(q: QuadList, eng: Engine, camX: number, camY: number) {
  const pool = eng.particles.pool;
  const count = eng.particles.count;
  const cam = eng.cam;
  const glowE = q.uv('glow')!;
  const starE = q.uv('p:star')!;
  const shardE = q.uv('p:shard')!;
  const petalE = q.uv('p:petal')!;
  const ringE = q.uv('p:ring')!;
  const sparkE = q.uv('p:spark')!;
  const runeE = [q.uv('p:rune0')!, q.uv('p:rune1')!, q.uv('p:rune2')!, q.uv('p:rune3')!];
  const cw = cam.w, ch = cam.h;
  for (let i = 0; i < count; i++) {
    const pt = pool[i];
    const t = pt.life / pt.maxLife;
    const x = pt.x - camX, y = pt.y - camY;
    if (x < -80 || y < -80 || x > cw + 80 || y > ch + 80) continue;
    const size = pt.endSize + (pt.size - pt.endSize) * t;
    if (size < 1.2) continue;
    let a = t < 0.35 ? t / 0.35 : 1;
    if (a > 1) a = 1;
    const [r, g, b, ca] = rgb(pt.color);
    a *= ca; // rgba() colours carry their intended strength in the alpha
    switch (pt.mode) {
      case 'glow':
        q.push(true, glowE, x, y, size, 0, a, r, g, b, 1);
        break;
      case 'smoke':
        q.push(false, glowE, x, y, size, 0, Math.min(0.5, t * 0.5) * ca, r, g, b, 1);
        break;
      case 'star':
        q.push(true, starE, x, y, size, pt.rot, a, r, g, b, 1);
        break;
      case 'shard':
        q.push(true, shardE, x, y, size, pt.rot, a, r, g, b, 1);
        break;
      case 'petal':
        q.push(true, petalE, x, y, size * 1.15, pt.rot, a, r, g, b, 1);
        break;
      case 'ring':
        q.push(true, ringE, x, y, size * (1 - t * 0.9 + 0.1) * 1.1, 0, a, r, g, b, 1);
        break;
      case 'spark': {
        const ang = Math.atan2(pt.vy, pt.vx);
        q.push(true, sparkE, x, y, size * 2.2, ang, a, r, g, b, 1, 0.3);
        break;
      }
      case 'rune':
        q.push(true, runeE[Math.floor(pt.seed) % 4], x, y, size * 1.2, pt.rot, a, r, g, b, 1);
        break;
    }
  }
}

// ---------------------------------------------------------------- enemies
// Per-type mapping from the animation clock to a baked-loop phase, plus the
// live vertical bob/hover kept continuous at blit time. `rate` matches the
// dominant sin() frequency each original live draw used (bat flap = animT*14);
// `bob(animT)` returns the live y-offset applied per-instance.
interface EnemyAnim { rate: number; bob: (animT: number) => number }
const ENEMY_ANIM: Record<string, EnemyAnim> = {
  wisp: { rate: 9, bob: () => 0 },
  bat: { rate: 14, bob: (t) => Math.sin(t * 5) * 2 },
  eye: { rate: 1, bob: (t) => Math.sin(t * 3) * 3 },      // body baked static
  // (eyeball+veins only); tentacles + iris are drawn live, so any rate is fine
  shade: { rate: 5, bob: () => 0 },
  golem: { rate: 2, bob: () => 0 },
  siren: { rate: 4, bob: (t) => Math.sin(t * 4) * 3 },
  warlock: { rate: 3, bob: (t) => Math.sin(t * 3) * 2 },
};

// Health bars for hurt / big enemies. Drawn on the 2D overlay layer (full res,
// crisp above the bloom). Capped at the player's HP-bar performance preset:
// when more enemies qualify than the cap, the ones nearest the player (plus
// every boss) win the slots.
const _hpElig: Enemy[] = [];
function drawHealthBars(eng: Engine, octx: CanvasRenderingContext2D, camX: number, camY: number, alpha: number) {
  const cap = settings.hpBarCap;
  const cam = eng.cam;
  const p = eng.player;
  const elig = _hpElig;
  elig.length = 0;
  for (const e of eng.enemies) {
    if (e.dead || e.hp >= e.maxHp || !(e.elite || e.boss || e.maxHp > 40)) continue;
    const x = (lerp(e.px, e.x, alpha)) - camX, y = (lerp(e.py, e.y, alpha)) - camY;
    if (x < -100 || y < -100 || x > cam.w + 100 || y > cam.h + 100) continue;
    elig.push(e);
  }
  // only pay the sort when we actually exceed the cap
  if (elig.length > cap) {
    elig.sort((a, b) => {
      if (a.boss !== b.boss) return a.boss ? -1 : 1; // bosses always shown
      return ((a.x - p.x) ** 2 + (a.y - p.y) ** 2) - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
    });
    elig.length = cap;
  }
  for (const e of elig) {
    const x = (lerp(e.px, e.x, alpha)) - camX, y = (lerp(e.py, e.y, alpha)) - camY;
    const bw = e.boss ? 90 : 30;
    const bx = x - bw / 2, by = y - e.radius - 14;
    octx.fillStyle = 'rgba(10,8,26,0.8)';
    octx.fillRect(bx - 1, by - 1, bw + 2, 6);
    octx.fillStyle = e.boss ? '#ff9ad5' : '#7ff5ff';
    octx.fillRect(bx, by, (bw * Math.max(0, e.hp)) / e.maxHp, 4);
  }
}

// Debug collision overlay (H). Draws the exact shapes the sim tests against:
//  · player hurtbox (yellow, green while i-frames/invuln active)
//  · enemy body collision (cyan)  · enemy melee attack radius (orange)
//  · player projectile collision (magenta) · enemy projectile collision (lime)
// Everything is stroked on the overlay in world→screen space.
function drawDebugHitboxes(eng: Engine, ctx: CanvasRenderingContext2D, ipx: number, ipy: number, alpha: number, camX: number, camY: number) {
  const circle = (wx: number, wy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(wx - camX, wy - camY, r, 0, TAU);
    ctx.stroke();
  };
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = 1.5;

  // enemies: body collision + (for melee types) attack reach against the hurtbox
  for (const e of eng.enemies) {
    if (e.dead) continue;
    const ex = lerp(e.px, e.x, alpha), ey = lerp(e.py, e.y, alpha);
    ctx.strokeStyle = 'rgba(120,230,255,0.85)'; // body collision
    circle(ex, ey, e.radius);
    if (isFinite(e.meleeBaseCd) && e.dmg > 0) {
      // reach = enemy radius + player radius + per-type bonus; this is the
      // centre-to-centre distance at which a strike lands, so draw it relative
      // to the enemy centre (a hit needs the hurtbox centre inside this ring).
      ctx.strokeStyle = e.meleeCd <= 0 ? 'rgba(255,170,60,0.9)' : 'rgba(255,170,60,0.35)';
      circle(ex, ey, e.radius + PLAYER_HURT_R + e.meleeReach);
    }
  }

  // player projectiles (magenta): collision radius
  ctx.strokeStyle = 'rgba(255,90,220,0.85)';
  for (const pr of eng.projectiles) {
    if (pr.dead) continue;
    circle(lerp(pr.px, pr.x, alpha), lerp(pr.py, pr.y, alpha), pr.r);
  }
  // enemy / boss projectiles: bp.r (~5-6px) is the TRUE collision radius, so the
  // ring must stay at bp.r — no floating markers that imply a bigger hitbox.
  for (const bp of eng.bossProjectiles) {
    if (bp.dead || bp.life <= 0) continue;
    const bx = lerp(bp.px, bp.x, alpha) - camX, by = lerp(bp.py, bp.y, alpha) - camY;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(bx, by, bp.r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#c6ff3a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, bp.r, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#c6ff3a';
    ctx.beginPath(); ctx.arc(bx, by, 1.3, 0, TAU); ctx.fill();
  }
  ctx.lineWidth = 1.5;

  // player hurtbox last, on top
  const hx = ipx - camX, hy = ipy + PLAYER_HURT_DY - camY;
  const p = eng.player;
  ctx.strokeStyle = p.iframes > 0 || p.invuln > 0 ? '#7dffb0' : '#ffe14d';
  ctx.beginPath();
  ctx.arc(hx, hy, PLAYER_HURT_R, 0, TAU);
  ctx.stroke();
  ctx.beginPath(); // centre cross
  ctx.moveTo(hx - 4, hy); ctx.lineTo(hx + 4, hy);
  ctx.moveTo(hx, hy - 4); ctx.lineTo(hx, hy + 4);
  ctx.stroke();
  ctx.restore();
}
