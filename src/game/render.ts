// Render layer: Canvas2D world pass (procedurally-animated vector entities,
// view-culled), GPU particle dispatch in the middle, thin 2D overlay on top.
// All moving entities are drawn at positions interpolated between the last two
// fixed simulation steps, so motion is smooth at any display refresh rate.

import type { Engine } from './engine';
import { centeredRadial, cachedLinear, ENEMY_TYPES, MELEE_ANIM_DUR, PLAYER_HURT_DY, PLAYER_HURT_R } from './engine';
import { TAU, clamp, type Enemy, type Zone, type Projectile, type BossProjectile, type Beam, type Bolt, type Gem, type Pickup } from './world';
import { blitEnemy, enemyFrameId, FRAMES, type TintKind } from './enemySprites';
import type { QuadList } from './worldGPU';
import { drawStats } from './perf';
import { settings } from './settings';

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

// Soft glow dot: replaces Canvas2D shadowBlur (which forces a full blur pass
// per draw on the browser's raster thread — the dominant hidden GPU cost with
// ~150 enemies each drawing 1-3 blurred glints). Implemented as a cached
// offscreen sprite blit: one Map.get on a constant colour string + one
// drawImage per call — no gradient fill raster, no per-call allocation.
const GLOW_RES = 64;
const _glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement {
  let c = _glowCache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = GLOW_RES;
  const g = c.getContext('2d')!;
  const r = GLOW_RES / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, GLOW_RES, GLOW_RES);
  _glowCache.set(color, c);
  return c;
}
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
}

// Full-screen sky and vignette, pre-rendered once into small offscreen
// canvases and stretched with a single drawImage per frame. Filling a
// 2560×1440 gradient rasterizes millions of pixels every frame browser-side;
// stretching a cached low-res texture of a smooth gradient is visually
// identical and near-free. Rebuilt only when the viewport size changes.
let _skyCanvas: HTMLCanvasElement | null = null;
let _skyH = -1;
let _vigCanvas: HTMLCanvasElement | null = null;
let _vigKey = '';

function skyLayer(h: number): HTMLCanvasElement {
  if (_skyH === h && _skyCanvas) return _skyCanvas;
  const c = _skyCanvas || (_skyCanvas = document.createElement('canvas'));
  // Full screen height (not a 256px texture stretched ~5x): magnifying a tiny
  // smooth dark gradient produces visible horizontal banding when the blit is
  // bilinearly filtered. Rendering the gradient at native height removes the
  // magnification entirely. Still 8px wide (a vertical gradient has no
  // horizontal variation) and rebuilt only on resize, so it stays near-free.
  c.width = 8;
  c.height = Math.max(1, Math.round(h));
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#0b0a1e');
  grad.addColorStop(0.5, '#141031');
  grad.addColorStop(1, '#1c1140');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, c.height);
  _skyH = h;
  return c;
}

function vignetteLayer(ctx: CanvasRenderingContext2D, w: number, h: number): HTMLCanvasElement {
  const key = w + 'x' + h;
  if (_vigKey === key && _vigCanvas) return _vigCanvas;
  // quarter-res is invisible for a smooth radial falloff
  const vw = Math.max(1, Math.round(w / 4)), vh = Math.max(1, Math.round(h / 4));
  const c = _vigCanvas || (_vigCanvas = document.createElement('canvas'));
  c.width = vw;
  c.height = vh;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.35, vw / 2, vh / 2, Math.max(vw, vh) * 0.72);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(5,3,18,0.55)');
  g.clearRect(0, 0, vw, vh);
  g.fillStyle = grad;
  g.fillRect(0, 0, vw, vh);
  _vigKey = key;
  return c;
}

// Damage-number sprites: floating texts redraw every frame (up to ~125 alive ×
// 2 fillText in a webfont — a burst-correlated raster spike). Each unique
// (string, size, colour) is rasterized once, backing shadow included, then
// blitted. The cache is cleared when it grows past a bound (damage values
// churn endlessly late-game).
const _textCache = new Map<string, HTMLCanvasElement>();
let _fontReady = false;
function textSprite(str: string, size: number, color: string): HTMLCanvasElement {
  const key = str + '|' + size + '|' + color;
  let c = _textCache.get(key);
  if (c) return c;
  // evict the oldest half on overflow (Map preserves insertion order) — a
  // full clear() re-baked every live sprite in one frame, a measured spike
  // under endgame crit spam where damage values are endlessly unique
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
  const ctx = eng.ctx;
  const cam = eng.cam;
  const { w, h } = cam;
  const vt = eng.vt;
  const p = eng.player;
  drawStats.enemyBlits = 0;
  drawStats.enemyLiveOps = 0;
  const world = eng.world; // WebGPU entity layer (null → Canvas2D fallback)

  // camera follows the interpolated player position, on the render clock
  const ipx = lerp(p.px, p.x, alpha);
  const ipy = lerp(p.py, p.y, alpha);
  if (rdt > 0) {
    cam.x += (ipx - w / 2 - cam.x) * Math.min(1, rdt * 6);
    cam.y += (ipy - h / 2 - cam.y) * Math.min(1, rdt * 6);
  }
  const camX = cam.x, camY = cam.y;

  // ======================================================= LAYER 1: 2D bottom
  // sky, parallax stars, drifting motes, then zones/beams/bolts (all "under"
  // entities). Cheap: one gradient blit + a few hundred tiny rects + ~34 zones.
  ctx.drawImage(skyLayer(h), 0, 0, w, h);

  ctx.save();
  for (let li = 0; li < eng.stars.length; li++) {
    const par = 0.12 + li * 0.1;
    ctx.fillStyle = ['#5b6bb5', '#8fa0e8', '#cdd8ff'][li];
    for (const s of eng.stars[li]) {
      const sx = ((s.x - camX * par) % 2000 + 2000) % 2000 - (2000 - w) / 2;
      const sy = ((s.y - camY * par) % 2000 + 2000) % 2000 - (2000 - h) / 2;
      if (sx < -5 || sy < -5 || sx > w + 5 || sy > h + 5) continue;
      const tw = 0.5 + 0.5 * Math.sin(vt * 2 + s.tw);
      ctx.globalAlpha = 0.25 + tw * 0.5;
      ctx.fillRect(sx, sy, s.s, s.s);
    }
  }
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of eng.motes) {
    const par = 0.55;
    const mx = ((m.x - camX * par + Math.sin(vt * 0.3 + m.ph) * 30) % 1800 + 1800) % 1800 - (1800 - w) / 2;
    const my = ((m.y - camY * par - vt * m.sp) % 1800 + 1800) % 1800 - (1800 - h) / 2;
    if (mx < -10 || my < -10 || mx > w + 10 || my > h + 10) continue;
    ctx.globalAlpha = 0.25 + 0.2 * Math.sin(vt + m.ph);
    ctx.save();
    ctx.translate(mx, my);
    ctx.fillStyle = centeredRadial(ctx, m.r * 3, [[0, m.hue], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, m.r * 3, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // zones + beams + bolts stay on Canvas2D (bespoke vector shapes, ~34 of them,
  // well under the draw-call budget that was the bottleneck)
  for (const z of eng.zones) drawZone(eng, ctx, z, alpha);
  for (const b of eng.beams) drawBeam(ctx, cam, b, alpha);
  for (const b of eng.bolts) drawBolt(ctx, cam, b);

  // ======================================================= LAYER 2: entities
  const pStart = performance.now();
  if (world) {
    // build one instance list for the whole entity world, then 2 GPU draws
    const q = eng.quads;
    q.reset();
    for (const s of eng.pickups) emitPickup(q, eng, s);
    for (const g of eng.gems) emitGem(q, cam, g, alpha);
    for (const e of eng.enemies) emitEnemy(q, eng, e, alpha);
    emitOrbitals(q, eng, alpha);
    for (const pr of eng.projectiles) emitProjectile(q, eng, pr, alpha);
    for (const bp of eng.bossProjectiles) emitBossProjectile(q, eng, bp, alpha);
    emitParticles(q, eng, cam);
    // player still drawn on the 2D bottom layer over zones but under GPU
    // entities would be wrong; draw it into the overlay-free host is also
    // wrong. Simplest correct spot: draw the player on the GPU layer too —
    // but it's a bespoke vector wizard. Draw it on the 2D bottom layer's
    // TOP is under entities. We keep the player on the host layer drawn last
    // here so it sits above zones; enemies on the GPU layer then composite
    // above it, which matches the original (enemies can overlap the player).
    world.begin(true);
    world.drawQuads(q);
    world.end();
    drawStats.worldQuads = q.alphaN + q.addN;
    drawStats.worldDrawCalls = (q.alphaN > 0 ? 1 : 0) + (q.addN > 0 ? 1 : 0);
  } else {
    // ---- Canvas2D fallback: draw entities straight onto the host layer ----
    for (const g of eng.gems) drawGem(ctx, cam, g, alpha);
    for (const s of eng.pickups) drawPickup(eng, ctx, s);
    for (const e of eng.enemies) drawEnemy(eng, ctx, e, alpha);
    drawOrbitals(eng, ctx, alpha);
    for (const pr of eng.projectiles) drawProjectile(eng, ctx, pr, alpha);
    for (const bp of eng.bossProjectiles) drawBossProjectile(eng, ctx, bp, alpha);
    eng.particles.draw(ctx, cam, false);
  }
  // player: bespoke vector wizard, always on the 2D host layer, drawn last so
  // it sits above zones. (On the GPU path it ends up beneath the GPU entity
  // canvas — same visual intent as the original, where the swarm overlaps you.)
  drawPlayer(eng, ctx, ipx, ipy);
  eng.lastParticleDrawMs = performance.now() - pStart;

  // ======================================================= LAYER 3: 2D overlay
  const octx = eng.octx || ctx;
  if (octx !== ctx) octx.clearRect(0, 0, w, h);

  // debug overlay (H): drawn on the TOP overlay layer so it sits above the GPU
  // entity canvas — on the GPU path entities composite above the host ctx, so a
  // ring drawn there would be hidden behind the very sprite it outlines. Every
  // shape reads the same constants/radii the engine uses (no drift).
  if (eng.debugHitbox) drawDebugHitboxes(eng, octx, ipx, ipy, alpha);

  // enemy health bars — one pass for both backends, on the crisp overlay layer
  drawHealthBars(eng, octx, cam, alpha);

  // damage texts — sprite-cached once the webfont is in (fillText fallback
  // until then, so sprites never bake with the wrong font)
  if (!_fontReady && document.fonts && document.fonts.check('700 16px Roboto')) _fontReady = true;
  octx.save();
  if (_fontReady) {
    for (const t of eng.texts) {
      octx.globalAlpha = Math.min(1, t.life * 2);
      const spr = textSprite(t.str, t.size, t.color) as any;
      octx.drawImage(spr, t.x - cam.x - spr._hw, t.y - cam.y - spr._base);
    }
  } else {
    octx.textAlign = 'center';
    let curFont = 0;
    for (const t of eng.texts) {
      octx.globalAlpha = Math.min(1, t.life * 2);
      if (t.size !== curFont) { octx.font = `700 ${t.size}px Roboto, sans-serif`; curFont = t.size; }
      const tx = t.x - cam.x, ty = t.y - cam.y;
      octx.fillStyle = 'rgba(6,4,16,0.6)';
      octx.fillText(t.str, tx + 1.2, ty + 1.2);
      octx.fillStyle = t.color;
      octx.fillText(t.str, tx, ty);
    }
  }
  octx.restore();

  // vignette — one stretched blit of a cached quarter-res layer
  octx.drawImage(vignetteLayer(octx, w, h), 0, 0, w, h);

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
    octx.fillStyle = '#7ff5ff';
    octx.shadowColor = '#7ff5ff';
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

// ==================================================== GPU quad emitters
// Each translates an entity's Canvas2D look into instanced atlas quads. Only
// the sprite body + its glow become quads; motions that were live (rotation,
// bob, tint) become per-instance quad params. Effects too bespoke to bake
// (rift spirals etc.) live on the 2D layers and aren't here.

const TINT_RGB: Record<TintKind, [number, number, number]> = {
  normal: [1, 1, 1],
  flash: [1, 1, 1],
  frozen: [0.75, 0.91, 1],
};

// generic colour parse → [r,g,b] 0..1 (cached)
const _rgbCache = new Map<string, [number, number, number]>();
function rgb(str: string): [number, number, number] {
  let c = _rgbCache.get(str);
  if (c) return c;
  c = [1, 1, 1];
  if (str[0] === '#') {
    let hx = str.slice(1);
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    const n = parseInt(hx, 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  } else if (str.startsWith('rgb')) {
    const m = str.match(/[\d.]+/g);
    if (m) c = [(+m[0]) / 255, (+m[1]) / 255, (+m[2]) / 255];
  }
  _rgbCache.set(str, c);
  return c;
}

function emitEnemy(q: QuadList, eng: Engine, e: Enemy, alpha: number) {
  const cam = eng.cam;
  const vt = eng.vt;
  const ix = lerp(e.px, e.x, alpha), iy = lerp(e.py, e.y, alpha);
  const x = ix - cam.x, y = iy - cam.y;
  // cull margin scales with the sprite: art extends to roughly 2× the collision
  // radius (e.g. eye radius 18 → art half-extent 34), so a boss (radius ~61,
  // art ~116px + corona) needs far more than the old fixed 90px or it pops
  // in/out while still partially on-screen.
  const cullM = Math.max(90, e.radius * 2 + 40);
  if (x < -cullM || y < -cullM || x > cam.w + cullM || y > cam.h + cullM) return;

  const tintKind: TintKind = e.hitFlash > 0 ? 'flash' : e.slowT > 0 ? 'frozen' : 'normal';
  const anim = ENEMY_ANIM[e.type];
  const type = e.boss ? 'eye' : e.type;
  const sc = e.boss ? e.radius / 18 : e.radius / ENEMY_TYPES[e.type].radius;
  const bob = anim.bob(e.animT);
  let fi = ((e.animT * anim.rate + e.seed) / TAU * FRAMES) | 0;
  fi = ((fi % FRAMES) + FRAMES) % FRAMES;
  const id = enemyFrameId(type, tintKind, fi);
  const entry = q.uv(id);
  if (!entry) return;
  const half = entry.half * sc;
  const [tr, tg, tb] = TINT_RGB[tintKind];
  const mix = tintKind === 'normal' ? 0 : 1;
  // eye tentacle crown: emitted UNDER the body as one live, continuously-rotating
  // quad (see 'tentacles' sprite). Smooth at any scale, unlike a baked morph —
  // this is what fixes the boss's magnified choppiness. Normal-tint crown keeps
  // its baked pink; flash/frozen tint via the per-instance mix like the body.
  if (e.type === 'eye') {
    const tentE = q.uv('tentacles');
    if (tentE) {
      const hover = Math.sin(e.animT * 3 + e.seed) * 3 * sc;
      const spin = e.animT * 0.4 + e.seed;   // slow continuous sway
      q.push(false, tentE, x, y + bob * sc + hover, tentE.half * sc, spin, 1, tr, tg, tb, mix);
      drawStats.enemyLiveOps++;
    }
  }
  q.push(false, entry, x, y + bob * sc, half, 0, 1, tr, tg, tb, mix);
  drawStats.enemyBlits++;

  // ---- live overlays as extra quads (smooth, on the global clock) ----
  const glowE = q.uv('glow')!;
  if (e.golden) {
    const ringE = q.uv('ring')!;
    const gr = e.radius + 8 + Math.sin(vt * 4) * 2;
    q.push(true, ringE, x, y, gr / 30 * ringE.half, 0, 0.8, 1, 0.82, 0.48, 1);
    drawStats.enemyLiveOps++;
  } else if (e.elite) {
    // crimson stroked corona ring + 4 orbiting thorn shards (matches original).
    // ring sprite is a 30px-radius outline → scale the quad so its stroke sits
    // at the corona radius: quadHalf/ringHalf * 30 = coronaR.
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
  }
  // golem: orbiting rock chunks (live quads, smooth)
  if (e.type === 'golem') {
    const rockE = q.uv('rock')!;
    const [gtr, gtg, gtb] = TINT_RGB[tintKind];
    for (let i = 0; i < 4; i++) {
      const ra = vt * 1.2 + (i / 4) * TAU;
      const R = (26 + Math.sin(vt * 3 + i) * 2) * sc;
      const rx = x + Math.cos(ra) * R;
      const ry = y + bob * sc + Math.sin(ra) * R * 0.5 - 6 * sc;
      q.push(false, rockE, rx, ry, rockE.half * sc, ra, 1, tintKind === 'normal' ? 0.23 : gtr, tintKind === 'normal' ? 0.37 : gtg, tintKind === 'normal' ? 0.54 : gtb, 1);
    }
    drawStats.enemyLiveOps++;
  }
  // warlock: orbiting charge-orbs (live additive quads, smooth)
  if (e.type === 'warlock') {
    const orbE = q.uv('orb')!;
    const charge = e.ranged ? clamp(1 - e.shootCd / 1.2, 0, 1) : 0;
    for (let i = 0; i < 3; i++) {
      const oa = vt * 2.4 + (i / 3) * TAU;
      const ox = x + Math.cos(oa) * 17 * sc;
      const oy = y + bob * sc + Math.sin(oa) * 8 * sc - 22 * sc;
      q.push(true, orbE, ox, oy, (5 + charge * 4) * sc, 0, 1);
    }
    drawStats.enemyLiveOps++;
  }
  // eye iris tracks the player (baked eyeball omits it): one iris quad rotated
  // toward the player (the sprite's pupil sits along local +x)
  if (e.type === 'eye') {
    const hover = Math.sin(e.animT * 3 + e.seed) * 3 * sc;
    const a = Math.atan2(eng.player.y - e.y, eng.player.x - e.x);
    const cy = y + bob * sc + hover;
    const irisE = q.uv('iris')!;
    q.push(false, irisE, x, cy, irisE.half * sc, a, 1);
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
}

function emitGem(q: QuadList, cam: Engine['cam'], g: Gem, alpha: number) {
  const gx = lerp(g.px, g.x, alpha), gy = lerp(g.py, g.y, alpha);
  const x = gx - cam.x, y = gy - cam.y + Math.sin(g.ph) * 3;
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

function emitPickup(q: QuadList, eng: Engine, s: Pickup) {
  const cam = eng.cam;
  const x = s.x - cam.x, y = s.y - cam.y;
  if (x < -60 || y < -60 || x > cam.w + 60 || y > cam.h + 60) return;
  const urgent = s.life < 5 ? 0.5 + 0.5 * Math.sin(eng.vt * 10) : 1;
  const glowE = q.uv('glow')!;
  const beaconE = q.uv('pickup:beacon')!;
  const ringE = q.uv('ring')!;
  const starE = q.uv('pickup:star')!;
  // vertical beacon: the beacon sprite paints a bright column in the TOP half of
  // its square tile (tile-y −half..0), so centring the quad ON the star anchors
  // the column's base there and lets it rise upward.
  q.push(true, beaconE, x, y, beaconE.half, 0, urgent, 0.5, 0.96, 1, 1);
  // pulsing ground ring where the star rests (cyan, additive)
  const ringPulse = 0.9 + Math.sin(s.ph) * 0.12;
  q.push(true, ringE, x, y + 6, 11 * ringPulse, 0, 0.5 * urgent, 0.5, 0.96, 1, 1);
  // soft glow halo + spinning five-point star core, both cyan
  q.push(true, glowE, x, y - 8, 26, 0, urgent, 0.5, 0.96, 1, 1);
  q.push(true, starE, x, y - 8, starE.half, s.ph * 0.6, urgent);
}

function emitOrbitals(q: QuadList, eng: Engine, alpha: number) {
  if (!eng.orbitals.length) return;
  const cam = eng.cam;
  const glowE = q.uv('glow')!;
  const petalE = q.uv('petal')!;
  for (const o of eng.orbitals) {
    const x = lerp(o.px, o.x, alpha) - cam.x, y = lerp(o.py, o.y, alpha) - cam.y;
    q.push(true, glowE, x, y, 14, 0, 0.8, 0.49, 1, 0.69, 1);     // green glow halo
    q.push(false, petalE, x, y, petalE.half, o.a * 2, 1);         // spinning blossom
  }
}

function emitProjectile(q: QuadList, eng: Engine, pr: Projectile, alpha: number) {
  const cam = eng.cam;
  const ix = lerp(pr.px, pr.x, alpha), iy = lerp(pr.py, pr.y, alpha);
  const x = ix - cam.x, y = iy - cam.y;
  if (x < -80 || y < -80 || x > cam.w + 80 || y > cam.h + 80) return;
  if (pr.kind === 'arcane') {
    const e = q.uv('proj:arcane')!;
    q.push(true, e, x, y, e.half, Math.atan2(pr.vy, pr.vx), 1);
  } else if (pr.kind === 'ember') {
    const e = q.uv('proj:ember')!;
    q.push(true, e, x, y, e.half, 0, 1);
  } else if (pr.kind === 'comet') {
    const e = q.uv('proj:arcane')!; // pink-tinted round head
    q.push(true, e, x, y, 15, Math.atan2(pr.ty - iy || 1, pr.tx - ix || 0.4), 1, 1, 0.7, 0.95, 1);
  } else if (pr.kind === 'fang') {
    const e = q.uv('proj:fang')!;
    q.push(false, e, x, y, e.half, Math.atan2(pr.vy, pr.vx), 1);
  } else if (pr.kind === 'glaive') {
    // Keep the halo small + faint so the blade shape reads as a glaive, not a
    // glowing orb. The big soft halo used to swamp the silhouette.
    const glowE = q.uv('glow')!;
    q.push(true, glowE, x, y, 26, 0, 0.28, 0.62, 0.85, 1); // subtle icy-blue halo
    const e = q.uv('proj:glaive')!; // baked twin-bladed star-blade, spinning
    q.push(false, e, x, y, e.half, pr.spin, 1);
    q.push(true, e, x, y, e.half, pr.spin, 0.18); // faint additive glint on the edge
  }
}

function emitBossProjectile(q: QuadList, eng: Engine, bp: BossProjectile, alpha: number) {
  if (bp.life <= 0) return;
  const cam = eng.cam;
  const ix = lerp(bp.px, bp.x, alpha), iy = lerp(bp.py, bp.y, alpha);
  const x = ix - cam.x, y = iy - cam.y;
  if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) return;
  const s = bp.r / 6;
  const pulse = 0.85 + 0.15 * Math.sin(eng.vt * 12 + (bp.x + bp.y) * 0.05);
  const glowE = q.uv('glow')!;
  q.push(true, glowE, x, y, 22 * s * pulse, 0, 0.9, 1, 0.4, 0.44, 1); // hot red halo
  const e = q.uv('proj:bullet')!;
  q.push(false, e, x, y, e.half * s, Math.atan2(bp.vy, bp.vx), 1);
}

function emitParticles(q: QuadList, eng: Engine, cam: Engine['cam']) {
  const pool = eng.particles.pool;
  const count = eng.particles.count;
  const glowE = q.uv('glow')!;
  const camX = cam.x, camY = cam.y, cw = cam.w, ch = cam.h;
  for (let i = 0; i < count; i++) {
    const pt = pool[i];
    // GPU path draws glow/smoke as quads; the rare vector modes are drawn on
    // the 2D overlay-free host layer via the fallback... but to avoid a 3rd
    // path we approximate ALL particle modes as tinted glow quads here. The
    // vector modes (star/shard/etc.) are a small minority and read fine as
    // soft glows at particle scale.
    const t = pt.life / pt.maxLife;
    const x = pt.x - camX, y = pt.y - camY;
    if (x < -80 || y < -80 || x > cw + 80 || y > ch + 80) continue;
    const size = pt.endSize + (pt.size - pt.endSize) * t;
    if (size < 1.2) continue;
    let a = t < 0.35 ? t / 0.35 : 1;
    if (a > 1) a = 1;
    const smoke = pt.mode === 'smoke';
    if (smoke) a = Math.min(0.5, t * 0.5);
    const [r, g, b] = rgb(pt.color);
    q.push(!smoke, glowE, x, y, size, 0, a, r, g, b, 1);
  }
}

// ---------------------------------------------------------------- pickups
function drawPickup(eng: Engine, ctx: CanvasRenderingContext2D, s: Pickup) {
  const cam = eng.cam;
  const x = s.x - cam.x, y = s.y - cam.y;
  if (x < -60 || y < -60 || x > cam.w + 60 || y > cam.h + 60) return;
  const urgent = s.life < 5 ? 0.5 + 0.5 * Math.sin(eng.vt * 10) : 1;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = urgent;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = cachedLinear(ctx, 0, -190, 0, 0, 'rgba(127,245,255,0)', 'rgba(127,245,255,0.3)');
  ctx.fillRect(-7, -190, 14, 190);
  ctx.restore();
  ctx.strokeStyle = '#7ff5ff';
  ctx.lineWidth = 1.6;
  ctx.globalAlpha = 0.5 * urgent;
  ctx.beginPath();
  ctx.ellipse(x, y + 6, 22 + Math.sin(s.ph) * 3, 8, 0, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = urgent;
  ctx.save();
  ctx.translate(x, y - 8);
  ctx.fillStyle = centeredRadial(ctx, 26, [[0, '#ffffff'], [0.4, '#7ff5ff'], [1, 'rgba(0,0,0,0)']]);
  ctx.beginPath();
  ctx.arc(0, 0, 26, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#eafeff';
  ctx.rotate(s.ph * 0.6);
  ctx.beginPath();
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU - Math.PI / 2;
    const a2 = a + TAU / 10;
    ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
    ctx.lineTo(Math.cos(a2) * 4.2, Math.sin(a2) * 4.2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// ---------------------------------------------------------------- gems
function drawGem(ctx: CanvasRenderingContext2D, cam: Engine['cam'], g: Gem, alpha: number) {
  const gx = lerp(g.px, g.x, alpha), gy = lerp(g.py, g.y, alpha);
  const x = gx - cam.x, y = gy - cam.y + Math.sin(g.ph) * 3;
  if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  if (g.shard) {
    const pulse = 1 + Math.sin(g.ph * 2.2) * 0.18;
    const r = 30 * pulse;
    ctx.fillStyle = centeredRadial(ctx, r, [[0, 'rgba(255,122,176,0.9)'], [0.45, 'rgba(255,90,122,0.5)'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(g.ph * 0.35);
    ctx.fillStyle = '#2a0f1e';
    ctx.strokeStyle = '#ff5a7a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(7, -3);
    ctx.lineTo(5, 10);
    ctx.lineTo(-5, 10);
    ctx.lineTo(-7, -3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff7ab0';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(2.8, 0);
    ctx.lineTo(0, 6);
    ctx.lineTo(-2.8, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return;
  }
  if (g.merged) {
    const s = 6.5;
    ctx.fillStyle = centeredRadial(ctx, s * 2.4, [[0, '#e6d1ff'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, s * 2.4, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(g.ph * 0.5);
    ctx.fillStyle = '#c8a8ff';
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.62, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s * 0.62, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, 1.6, 0, TAU);
    ctx.fill();
    ctx.restore();
    return;
  }
  const c = g.heal ? '#7dffb0' : g.big ? '#ffd27a' : '#7ff5ff';
  const s = g.heal ? 9 : g.big ? 8 : 5.5;
  ctx.fillStyle = centeredRadial(ctx, s * 2.4, [[0, c], [1, 'rgba(0,0,0,0)']]);
  ctx.beginPath();
  ctx.arc(0, 0, s * 2.4, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.rotate(g.ph * 0.5);
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.62, 0);
  ctx.lineTo(0, s);
  ctx.lineTo(-s * 0.62, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.5);
  ctx.lineTo(s * 0.26, 0);
  ctx.lineTo(0, s * 0.5);
  ctx.lineTo(-s * 0.26, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- zones
function drawZone(eng: Engine, ctx: CanvasRenderingContext2D, z: Zone, alpha: number) {
  const cam = eng.cam;
  const vt = eng.vt;
  const zx = lerp(z.px, z.x, alpha), zy = lerp(z.py, z.y, alpha);
  const zr = lerp(z.pr, z.r, alpha);
  const x = zx - cam.x, y = zy - cam.y;
  if (z.kind === 'frostwave') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const t = z.life / z.maxLife;
    ctx.globalAlpha = Math.max(0, t);
    // soft halo via a wide translucent stroke (shadowBlur on a screen-sized
    // ring rasterizes a huge blur surface — this reads the same at a glance)
    ctx.strokeStyle = 'rgba(143,232,255,0.3)';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(x, y, zr, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#bff1ff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(x, y, zr, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, zr * 0.86, 0, TAU);
    ctx.stroke();
    ctx.restore();
  } else if (z.kind === 'rift') {
    ctx.save();
    const fade = Math.min(1, z.life * 2, (z.maxLife - z.life) * 3);
    ctx.globalAlpha = Math.max(0, fade);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = centeredRadial(ctx, zr, [[0, 'rgba(10,4,25,0.95)'], [0.55, 'rgba(43,16,80,0.75)'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, zr, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
    // spiral arms: wide translucent under-stroke instead of shadowBlur
    for (const [lw, col] of [[6.5, 'rgba(154,92,255,0.32)'], [2.4, '#9a5cff']] as [number, string][]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const f = i / 24;
          const a = z.spin + arm * (TAU / 3) + f * 2.6;
          const R = zr * (1 - f) * 0.95;
          const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    const hr = zr * 0.32 + Math.sin(vt * 6) * 2;
    ctx.strokeStyle = 'rgba(255,154,213,0.35)';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(x, y, hr, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#ff9ad5';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, hr, 0, TAU);
    ctx.stroke();
    ctx.restore();
  } else if (z.kind === 'nebula') {
    ctx.save();
    const fade = Math.min(1, z.life * 1.5, (z.maxLife - z.life) * 2);
    ctx.globalAlpha = Math.max(0, fade * 0.8);
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = centeredRadial(ctx, zr, [[0, 'rgba(158,110,230,0.16)'], [0.72, 'rgba(158,110,230,0.14)'], [0.92, 'rgba(196,140,255,0.07)'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, zr, 0, TAU);
    ctx.fill();
    ctx.restore();
    for (let i = 0; i < 3; i++) {
      const aa = z.seed + i * 2.1 + vt * 0.3;
      const lx = x + Math.cos(aa) * zr * 0.28;
      const ly = y + Math.sin(aa) * zr * 0.28;
      const lr = zr * (0.55 + 0.08 * Math.sin(vt * 1.4 + i * 2));
      ctx.save();
      ctx.translate(lx, ly);
      ctx.fillStyle = centeredRadial(ctx, lr, [[0, ['rgba(196,140,255,0.2)', 'rgba(255,154,213,0.16)', 'rgba(138,123,255,0.18)'][i]], [1, 'rgba(0,0,0,0)']]);
      ctx.beginPath();
      ctx.arc(0, 0, lr, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  } else if (z.kind === 'sigil') {
    ctx.save();
    const f = 1 - z.life / z.maxLife;
    const pulse = 0.5 + 0.5 * Math.sin(vt * (6 + f * 18));
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 + Math.max(0, Math.min(1, f)) * 0.5;
    const sigR = zr * (0.4 + f * 0.6);
    ctx.strokeStyle = `rgba(255,210,122,${0.22 + pulse * 0.16})`;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(x, y, sigR, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, sigR, 0, TAU);
    ctx.stroke();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(vt * 1.5);
    const rr = zr * 0.45 * (0.4 + f * 0.6);
    ctx.strokeStyle = '#b48cff';
    ctx.beginPath();
    for (let k = 0; k <= 3; k++) {
      const aa = (k / 3) * TAU - Math.PI / 2;
      k === 0 ? ctx.moveTo(Math.cos(aa) * rr, Math.sin(aa) * rr) : ctx.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff2cc';
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0.6, TAU - 0.6);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  } else if (z.kind === 'scorch') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fade = Math.min(1, z.life * 1.2, (z.maxLife - z.life) * 4);
    const flick = 0.85 + 0.15 * Math.sin(vt * 9 + z.seed);
    ctx.globalAlpha = Math.max(0, 0.2 * fade * flick);
    ctx.translate(x, y);
    ctx.fillStyle = centeredRadial(ctx, zr, [[0, z.c1], [0.7, z.c2], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, zr, 0, TAU);
    ctx.fill();
    ctx.restore();
  } else if (z.kind === 'novawave') {
    if (z.delay && z.delay > 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const t = z.life / z.maxLife;
    ctx.globalAlpha = Math.max(0, Math.min(1, t));
    ctx.strokeStyle = 'rgba(255,154,213,0.3)';
    ctx.lineWidth = 22;
    ctx.beginPath();
    ctx.arc(x, y, zr, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#ff9ad5';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(x, y, zr, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#5a2a6e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, zr * 0.9, 0, TAU);
    ctx.stroke();
    ctx.restore();
  } else if (z.kind === 'lantern') {
    ctx.save();
    const fade = Math.min(1, z.life * 2, (z.maxLife - z.life) * 4);
    const breath = 0.5 + 0.5 * Math.sin(z.ph * 0.9);
    // The pool glow is additive, so many overlapping lanterns (especially the
    // evolution, which spawns more and pulses faster) sum well past white — a
    // "disco" strobe. Draw the wide pool with 'source-over' (it just tints,
    // doesn't stack to white) at a soft alpha; keep only the small flame core
    // additive. Flicker amplitude cut so it breathes instead of strobing.
    ctx.globalAlpha = Math.max(0, fade * (0.16 + breath * 0.05));
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = centeredRadial(ctx, zr, [[0, 'rgba(120,220,200,0.4)'], [0.45, 'rgba(90,190,170,0.18)'], [0.8, 'rgba(74,217,196,0.05)'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, zr, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
    const sway = Math.sin(z.ph) * 3;
    const ly = y - 26 + Math.sin(z.ph * 0.7) * 2;
    ctx.globalAlpha = Math.max(0, fade * 0.7);
    const flick = 0.95 + Math.sin(z.ph * 2.6) * 0.04 + breath * 0.08;
    ctx.save();
    ctx.translate(x + sway, ly);
    ctx.fillStyle = centeredRadial(ctx, 18 * flick, [[0, '#e8fff8'], [0.4, '#a8ffe8'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 18 * flick, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#1a3a34';
    ctx.fillRect(x + sway - 5, ly - 11, 10, 3);
    ctx.fillRect(x + sway - 4, ly + 8, 8, 2.5);
    ctx.strokeStyle = '#4ad9c4';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x + sway - 5.5, ly - 8, 11, 16);
    ctx.fillStyle = '#4ad9c4';
    ctx.beginPath();
    ctx.ellipse(x + sway, ly, 3, 4.5 + Math.sin(z.ph * 5), 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------- projectiles
function drawProjectile(eng: Engine, ctx: CanvasRenderingContext2D, pr: Projectile, alpha: number) {
  const cam = eng.cam;
  const ix = lerp(pr.px, pr.x, alpha), iy = lerp(pr.py, pr.y, alpha);
  const x = ix - cam.x, y = iy - cam.y;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (pr.kind === 'arcane') {
    const a = Math.atan2(pr.vy, pr.vx);
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = centeredRadial(ctx, 14, [[0, '#ffffff'], [0.4, '#b48cff'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#e6d1ff';
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-8, 4.4);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-8, -4.4);
    ctx.closePath();
    ctx.fill();
  } else if (pr.kind === 'ember') {
    ctx.translate(x, y);
    ctx.fillStyle = centeredRadial(ctx, 16, [[0, '#fff6d8'], [0.4, '#ffd27a'], [1, 'rgba(255,90,60,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, TAU);
    ctx.fill();
  } else if (pr.kind === 'comet') {
    // landing marker: a soft contracting ring where the star will strike
    const f = Math.min(1, pr.t / pr.dur);
    const mx = pr.tx - cam.x, my = pr.ty - cam.y;
    ctx.save();
    ctx.globalAlpha = 0.25 + f * 0.45;
    ctx.strokeStyle = '#ffb3f2';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(mx, my, 26 - f * 14, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,179,242,0.5)';
    ctx.beginPath();
    ctx.arc(mx, my, 2.5, 0, TAU);
    ctx.fill();
    ctx.restore();
    const a = Math.atan2(pr.ty - iy || 1, pr.tx - ix || 0.4);
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = cachedLinear(ctx, -70, 0, 10, 0, 'rgba(138,123,255,0)', 'rgba(255,179,242,0.75)');
    ctx.beginPath();
    ctx.moveTo(-70, 0);
    ctx.lineTo(4, -6);
    ctx.lineTo(4, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = centeredRadial(ctx, 15, [[0, '#ffffff'], [0.4, '#ffb3f2'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, TAU);
    ctx.fill();
  } else if (pr.kind === 'fang') {
    const a = Math.atan2(pr.vy, pr.vx);
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = centeredRadial(ctx, 18, [[0, 'rgba(138,92,217,0.85)'], [1, 'rgba(32,18,61,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#c9a4ff';
    ctx.beginPath();
    ctx.arc(0, 0, 12, -1.25, 1.25);
    ctx.arc(-5, 0, 10, 1.05, -1.05, true);
    ctx.closePath();
    ctx.fill();
  } else if (pr.kind === 'glaive') {
    const moveA = pr.returning
      ? Math.atan2(eng.player.y - 20 - iy, eng.player.x - ix)
      : pr.a;
    ctx.translate(x, y);
    ctx.save();
    ctx.rotate(moveA);
    ctx.fillStyle = cachedLinear(ctx, -56, 0, 0, 0, 'rgba(159,216,255,0)', 'rgba(232,246,255,0.55)');
    ctx.fillRect(-56, -3, 56, 6);
    ctx.restore();
    // tight, faint icy halo so the blade silhouette reads as a glaive, not an orb
    ctx.fillStyle = centeredRadial(ctx, 24, [[0, 'rgba(159,216,255,0.28)'], [1, 'rgba(159,216,255,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, TAU);
    ctx.fill();
    ctx.rotate(pr.spin);
    ctx.shadowColor = '#9fd8ff';
    ctx.shadowBlur = 14;
    for (const side of [0, Math.PI]) {
      ctx.save();
      ctx.rotate(side);
      ctx.fillStyle = '#e8f6ff';
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.quadraticCurveTo(27, -22, 41, -5);
      ctx.quadraticCurveTo(26, -8, 11, 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#9fd8ff';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.moveTo(11, 1);
      ctx.quadraticCurveTo(27, -10, 41, -5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawBossProjectile(eng: Engine, ctx: CanvasRenderingContext2D, bp: BossProjectile, alpha: number) {
  if (bp.life <= 0) return;
  const cam = eng.cam;
  const ix = lerp(bp.px, bp.x, alpha), iy = lerp(bp.py, bp.y, alpha);
  const x = ix - cam.x, y = iy - cam.y;
  if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) return;
  const a = Math.atan2(bp.vy, bp.vx);
  const s = bp.r / 6;
  const pulse = 0.85 + 0.15 * Math.sin(eng.vt * 12 + (bp.x + bp.y) * 0.05);
  const sp = Math.hypot(bp.vx, bp.vy) || 1;
  const tl = Math.min(26, sp * 0.045) * s;
  if (tl > 4) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#ff5a64';
    ctx.lineWidth = 3.2 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - (bp.vx / sp) * tl, y - (bp.vy / sp) * tl);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  const gr = Math.round(22 * s * pulse);
  ctx.fillStyle = centeredRadial(ctx, gr, [[0, 'rgba(255,120,120,0.95)'], [0.35, 'rgba(255,60,70,0.6)'], [1, 'rgba(0,0,0,0)']]);
  ctx.beginPath();
  ctx.arc(0, 0, gr, 0, TAU);
  ctx.fill();
  ctx.rotate(a);
  ctx.globalCompositeOperation = 'source-over';
  ctx.scale(s, s);
  ctx.fillStyle = '#1a0a14';
  ctx.strokeStyle = 'rgba(255,210,215,0.95)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(11, 0);
  ctx.lineTo(2, -3);
  ctx.lineTo(-2, -6);
  ctx.lineTo(-4, -2);
  ctx.lineTo(-9, 0);
  ctx.lineTo(-4, 2);
  ctx.lineTo(-2, 6);
  ctx.lineTo(2, 3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ff5a6e';
  ctx.beginPath();
  ctx.arc(0.5, 0, 3.4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ffd6da';
  ctx.beginPath();
  ctx.arc(0.5, 0, 1.5, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawBeam(ctx: CanvasRenderingContext2D, cam: Engine['cam'], b: Beam, alpha: number) {
  const t = b.life / b.maxLife;
  const x = b.x - cam.x, y = b.y - cam.y;
  const a = lerp(b.pa, b.a, alpha);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  const tc = Math.max(0, t);
  ctx.globalCompositeOperation = 'lighter';
  const wNow = b.w * (0.4 + 0.6 * Math.sin(tc * Math.PI));
  // The beam covers a long strip, so keep it clearly translucent — the body
  // glow and the thin core are both roughly halved vs. before so enemies and
  // pickups under the lance stay readable.
  const g = ctx.createLinearGradient(0, -wNow, 0, wNow);
  g.addColorStop(0, 'rgba(255,243,184,0)');
  g.addColorStop(0.5, `rgba(255,250,225,${0.4 * tc + 0.05})`);
  g.addColorStop(1, 'rgba(188,217,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, -wNow, b.len, wNow * 2);
  ctx.fillStyle = `rgba(255,255,255,${0.45 * tc})`;
  ctx.fillRect(0, -wNow * 0.16, b.len, wNow * 0.32);
  // origin crescent: fade + expand as the lance dissipates so it eases out
  // instead of blinking off at end-of-life. Alpha tracks remaining life; the
  // arc widens and thins slightly as it fades, reading as a swing trailing off.
  const cf = tc;                         // 1 at spawn → 0 at death
  ctx.globalAlpha = cf;
  ctx.strokeStyle = '#fff3b8';
  ctx.lineWidth = 3 * (0.4 + 0.6 * cf);
  ctx.shadowColor = '#fff3b8';
  ctx.shadowBlur = 18 * cf;
  const cr = 18 + (1 - cf) * 10;         // expands outward as it fades
  const gap = 0.6 + (1 - cf) * 0.5;      // crescent opens up while dissipating
  ctx.beginPath();
  ctx.arc(0, 0, cr, gap, TAU - gap);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawBolt(ctx: CanvasRenderingContext2D, cam: Engine['cam'], b: Bolt) {
  const t = b.life / b.maxLife;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.max(0, t);
  // three plain strokes fake the old blurred double-stroke without a blur pass
  for (const [lw, col] of [[10, 'rgba(122,215,255,0.22)'], [5, 'rgba(122,215,255,0.5)'], [2, '#ffffff']] as [number, string][]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < b.n; i++) {
      const x = b.ptsX[i] - cam.x, y = b.ptsY[i] - cam.y;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawOrbitals(eng: Engine, ctx: CanvasRenderingContext2D, alpha: number) {
  if (!eng.orbitals.length) return;
  const cam = eng.cam;
  ctx.save();
  for (const o of eng.orbitals) {
    const x = lerp(o.px, o.x, alpha) - cam.x, y = lerp(o.py, o.y, alpha) - cam.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o.a * 2);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = centeredRadial(ctx, 14, [[0, 'rgba(125,255,176,0.8)'], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
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
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- player
function drawPlayer(eng: Engine, ctx: CanvasRenderingContext2D, ipx: number, ipy: number) {
  const p = eng.player;
  const cam = eng.cam;
  const vt = eng.vt;
  const x = ipx - cam.x, y = ipy - cam.y;
  const bob = Math.sin(p.animT * 6) * (p.moving ? 3 : 1.4);
  const sway = Math.sin(p.animT * 6 + 1) * (p.moving ? 0.08 : 0.03);
  const blink = (p.iframes > 0 || p.invuln > 0) && Math.sin(vt * 40) > 0;
  ctx.save();
  ctx.translate(x, y);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 8, 18, 6, 0, 0, TAU);
  ctx.fill();

  if (blink) ctx.globalAlpha = 0.45;
  ctx.scale(p.facing, 1);
  ctx.translate(0, bob * -1);
  ctx.rotate(sway);

  // robe — layered, with wavy hem
  const hemT = p.animT * 8;
  const robe = (w1: number, w2: number, hY: number, col: string) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-w1, -26);
    ctx.quadraticCurveTo(-w2 - 2, -6, -w2, hY);
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      ctx.lineTo(-w2 + f * w2 * 2, hY + Math.sin(hemT + f * 9) * 2.2);
    }
    ctx.quadraticCurveTo(w2 + 2, -6, w1, -26);
    ctx.closePath();
    ctx.fill();
  };
  robe(9, 16, 8, '#241a4d');
  robe(8, 13, 5, '#3b2a78');
  // belt & moon sigil
  ctx.fillStyle = '#ffd27a';
  ctx.fillRect(-8, -14, 16, 2.4);
  ctx.strokeStyle = '#8fe8ff';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(0, -4, 4.4, 0.7, TAU - 0.7);
  ctx.stroke();

  // head
  ctx.fillStyle = '#f2d9c0';
  ctx.beginPath();
  ctx.arc(1, -32, 6.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#1a1330';
  ctx.beginPath();
  ctx.arc(3.4, -33, 1, 0, TAU);
  ctx.fill();

  // hat: wide brim + bent cone with star
  const hatBend = Math.sin(p.animT * 3) * 1.5;
  ctx.fillStyle = '#2c1f63';
  ctx.beginPath();
  ctx.ellipse(0.5, -36, 13.5, 3.6, -0.06, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#3b2a78';
  ctx.beginPath();
  ctx.moveTo(-7.5, -37);
  ctx.quadraticCurveTo(-3, -52, 2 + hatBend, -56);
  ctx.quadraticCurveTo(7 + hatBend, -58, 4 + hatBend, -50);
  ctx.quadraticCurveTo(7, -44, 8, -37.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffd27a';
  ctx.save();
  ctx.translate(3.5 + hatBend, -54);
  ctx.rotate(vt * 1.5);
  ctx.beginPath();
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU - Math.PI / 2;
    const a2 = a + TAU / 10;
    ctx.lineTo(Math.cos(a) * 3, Math.sin(a) * 3);
    ctx.lineTo(Math.cos(a2) * 1.3, Math.sin(a2) * 1.3);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // staff arm + staff with pulsing orb
  ctx.strokeStyle = '#f2d9c0';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(4, -22);
  ctx.lineTo(13, -26);
  ctx.stroke();
  ctx.strokeStyle = '#6b4a2a';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(14, 6);
  ctx.quadraticCurveTo(15.5, -20, 14, -44);
  ctx.stroke();
  const pulse = 5 + Math.sin(vt * 5) * 1.2 + p.castPulse * 6;
  ctx.globalCompositeOperation = 'lighter';
  ctx.save();
  ctx.translate(14, -48);
  ctx.fillStyle = centeredRadial(ctx, pulse * 2.4, [[0, '#ffffff'], [0.35, '#7ff5ff'], [1, 'rgba(0,0,0,0)']]);
  ctx.beginPath();
  ctx.arc(0, 0, pulse * 2.4, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#bff9ff';
  ctx.beginPath();
  ctx.arc(14, -48, 3.6, 0, TAU);
  ctx.fill();

  ctx.restore();
}

// Debug collision overlay (H). Draws the exact shapes the sim tests against:
//  · player hurtbox (yellow, green while i-frames/invuln active)
//  · enemy body collision (cyan)  · enemy melee attack radius (orange)
//  · player projectile collision (magenta) · enemy projectile collision (lime)
// Everything is stroked on the host layer in world→screen space.
function drawDebugHitboxes(eng: Engine, ctx: CanvasRenderingContext2D, ipx: number, ipy: number, alpha: number) {
  const cam = eng.cam;
  const circle = (wx: number, wy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(wx - cam.x, wy - cam.y, r, 0, TAU);
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
  // Visibility comes from a thick opaque lime ring over a dark halo, plus a
  // centre dot, all at real scale.
  for (const bp of eng.bossProjectiles) {
    if (bp.dead || bp.life <= 0) continue;
    const bx = lerp(bp.px, bp.x, alpha) - cam.x, by = lerp(bp.py, bp.y, alpha) - cam.y;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(bx, by, bp.r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#c6ff3a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, bp.r, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#c6ff3a';
    ctx.beginPath(); ctx.arc(bx, by, 1.3, 0, TAU); ctx.fill();
  }
  ctx.lineWidth = 1.5;

  // player hurtbox last, on top
  const hx = ipx - cam.x, hy = ipy + PLAYER_HURT_DY - cam.y;
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

// ---------------------------------------------------------------- enemies
// Per-type mapping from the animation clock to a baked-loop phase, plus the
// live vertical bob/hover kept continuous at blit time. `rate` matches the
// dominant sin() frequency each live drawX used (bat flap = animT*14, etc.);
// `bob(animT)` returns the live y-offset the original applied via translate.
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
// above the GPU entity canvas) so they show on both render backends. Capped at
// the player's HP-bar performance preset: when more enemies qualify than the
// cap, the ones nearest the player (plus every boss) win the slots.
const _hpElig: Enemy[] = [];
function drawHealthBars(eng: Engine, octx: CanvasRenderingContext2D, cam: Engine['cam'], alpha: number) {
  const cap = settings.hpBarCap;
  const p = eng.player;
  const elig = _hpElig;
  elig.length = 0;
  for (const e of eng.enemies) {
    if (e.dead || e.hp >= e.maxHp || !(e.elite || e.boss || e.maxHp > 40)) continue;
    const x = (lerp(e.px, e.x, alpha)) - cam.x, y = (lerp(e.py, e.y, alpha)) - cam.y;
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
    const x = (lerp(e.px, e.x, alpha)) - cam.x, y = (lerp(e.py, e.y, alpha)) - cam.y;
    const bw = e.boss ? 90 : 30;
    const bx = x - bw / 2, by = y - e.radius - 14;
    octx.fillStyle = 'rgba(10,8,26,0.8)';
    octx.fillRect(bx, by, bw, 4);
    octx.fillStyle = e.boss ? '#ff9ad5' : '#7ff5ff';
    octx.fillRect(bx, by, (bw * Math.max(0, e.hp)) / e.maxHp, 4);
  }
}

function drawEnemy(eng: Engine, ctx: CanvasRenderingContext2D, e: Enemy, alpha: number) {
  const cam = eng.cam;
  const vt = eng.vt;
  const ix = lerp(e.px, e.x, alpha), iy = lerp(e.py, e.y, alpha);
  const x = ix - cam.x, y = iy - cam.y;
  // sprite-scaled cull margin — same rationale as emitEnemy (boss art far
  // exceeds the old fixed margin and popped at screen edges)
  const cullM = Math.max(80, e.radius * 2 + 40);
  if (x < -cullM || y < -cullM || x > cam.w + cullM || y > cam.h + cullM) return;
  const p = eng.player;
  ctx.save();
  ctx.translate(x, y);

  // melee strike lunge: the whole body snaps toward the player then eases back.
  // phase goes 1 (just struck) -> 0 (done); lunge is a fast-out / ease-back pop.
  let strikePhase = 0, strikeAng = 0;
  if (e.meleeAnim > 0) {
    strikePhase = Math.min(1, e.meleeAnim / MELEE_ANIM_DUR);
    strikeAng = Math.atan2(p.y + PLAYER_HURT_DY - (y + cam.y), p.x - (x + cam.x));
    // pop: peaks early (sqrt front-loads the lunge) so the hit reads instantly
    const pop = Math.sin(strikePhase * Math.PI) * (0.6 + 0.4 * Math.sqrt(strikePhase));
    const lunge = (e.radius * 0.7 + 12) * pop;
    ctx.translate(Math.cos(strikeAng) * lunge, Math.sin(strikeAng) * lunge);
  }

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, e.radius * 0.55, e.radius * 0.85, e.radius * 0.3, 0, 0, TAU);
  ctx.fill();

  // elite/golden coronas stay live (they pulse and orbit) — cheap ring draws
  if (e.golden) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,210,122,0.6)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#ffd27a';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0, 0, e.radius + 8 + Math.sin(vt * 4) * 2, 0, TAU);
    ctx.stroke();
    ctx.restore();
    drawStats.enemyLiveOps++;
  } else if (e.elite) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,90,122,0.75)';
    ctx.lineWidth = 2.2;
    ctx.shadowColor = '#ff5a7a';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(0, 0, e.radius + 9 + Math.sin(vt * 5) * 2, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,90,122,0.3)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, e.radius + 15, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = '#ff5a7a';
    for (let i = 0; i < 4; i++) {
      const a = vt * 1.8 + (i / 4) * TAU;
      const R = e.radius + 15;
      ctx.save();
      ctx.translate(Math.cos(a) * R, Math.sin(a) * R);
      ctx.rotate(a + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(3.4, 4);
      ctx.lineTo(-3.4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    drawStats.enemyLiveOps++;
  }

  const tintKind: TintKind = e.hitFlash > 0 ? 'flash' : e.slowT > 0 ? 'frozen' : 'normal';
  const anim = ENEMY_ANIM[e.type];
  const sc = e.boss ? e.radius / 18 : e.radius / ENEMY_TYPES[e.type].radius;
  // live vertical bob (same values the original applied inside each drawX)
  const bob = anim.bob(e.animT);
  // loop phase: same sin() argument the live shape used, mod one period,
  // with the per-enemy seed as a phase offset so enemies aren't in lockstep
  const ph = (e.animT * anim.rate + e.seed) / TAU;

  ctx.save();
  ctx.translate(0, bob);
  ctx.scale(sc, sc);
  // eye-boss crown of shards orbits on the global clock — can't be baked
  if (e.type === 'eye' && e.boss) {
    const hover = Math.sin(e.animT * 3 + e.seed) * 3;
    ctx.save();
    ctx.translate(0, hover);
    ctx.fillStyle = '#c48cff';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + vt * 0.8;
      const R = 30 + Math.sin(vt * 2 + i) * 3;
      ctx.save();
      ctx.translate(Math.cos(a) * R, Math.sin(a) * R * 0.6 - 14);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -6); ctx.lineTo(3, 0); ctx.lineTo(0, 6); ctx.lineTo(-3, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  // eye tentacle crown: live continuous rotation, drawn UNDER the baked eyeball
  // (mirrors the GPU path; keeps the boss smooth at scale). Baked body is arms-less.
  if (e.type === 'eye') { drawEyeTentacles(ctx, e); drawStats.enemyLiveOps++; }
  blitEnemy(ctx, e.type, ph, tintKind);
  drawStats.enemyBlits++;
  // eye's iris tracks the player → drawn live over the baked (irisless) eyeball
  if (e.type === 'eye') { drawEyeIris(ctx, e, p); drawStats.enemyLiveOps++; }
  ctx.restore();

  // siren/warlock spend most of their time NOT charging (baked at rest); when
  // charging, overlay the live glow the baked frame omits
  if ((e.type === 'siren' || e.type === 'warlock') && e.ranged) {
    drawCasterCharge(eng, ctx, e, p, sc, bob);
    drawStats.enemyLiveOps++;
  }

  // melee slash: bright white-cored crescent sweeping toward the player, drawn
  // over the body so it always reads regardless of enemy colour/background.
  if (strikePhase > 0) {
    const f = strikePhase;                 // 1 -> 0
    const grow = 1 - f;                     // 0 -> 1: the arc flies outward
    const reach = e.radius + e.meleeReach;
    const cx = Math.cos(strikeAng) * (e.radius * 0.4 + reach * grow);
    const cy = Math.sin(strikeAng) * (e.radius * 0.4 + reach * grow);
    const arcR = e.radius * 0.9 + e.meleeReach * 0.8;
    const half = 1.15 * (0.5 + 0.5 * f);    // wide at strike, narrowing as it fades
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // colored outer swipe
    ctx.globalAlpha = 0.9 * f;
    ctx.strokeStyle = e.color;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, strikeAng - half, strikeAng + half);
    ctx.stroke();
    // bright white core line on top
    ctx.globalAlpha = f;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, strikeAng - half * 0.8, strikeAng + half * 0.8);
    ctx.stroke();
    // impact flash at the leading edge, first half of the anim only
    if (f > 0.5) {
      const ff = (f - 0.5) * 2;
      ctx.globalAlpha = ff;
      ctx.fillStyle = centeredRadial(ctx, 14, [[0, '#ffffff'], [0.5, e.color], [1, 'rgba(0,0,0,0)']]);
      ctx.save();
      ctx.translate(Math.cos(strikeAng) * reach, Math.sin(strikeAng) * reach);
      ctx.beginPath();
      ctx.arc(0, 0, 14 * ff, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  ctx.restore();
  // health bars are drawn in a unified overlay pass (drawHealthBars) so they
  // appear on both the GPU and Canvas2D entity paths and stay crisp at full res
}

// live tentacle crown under the baked eyeball. Continuous rotation → smooth at
// any scale (the baked body no longer contains the arms). ctx is at the enemy
// centre + scaled; drawn before the body so the arms sit behind the eyeball.
function drawEyeTentacles(ctx: CanvasRenderingContext2D, e: Enemy) {
  const hover = Math.sin(e.animT * 3 + e.seed) * 3;
  ctx.save();
  ctx.translate(0, hover);
  ctx.rotate(e.animT * 0.4 + e.seed);
  ctx.strokeStyle = '#c76ba3';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const ta = (i / 7) * TAU;
    const cs = Math.cos(ta), sn = Math.sin(ta);
    const px = -sn, py = cs, curl = 3;
    ctx.beginPath();
    ctx.moveTo(cs * 14, sn * 14);
    ctx.quadraticCurveTo(cs * 22 + px * curl, sn * 22 + py * curl, cs * 27, sn * 27 - 2);
    ctx.stroke();
  }
  ctx.restore();
}

// live iris over the baked eyeball. ctx is already at the enemy centre + scaled.
function drawEyeIris(ctx: CanvasRenderingContext2D, e: Enemy, p: Engine['player']) {
  const hover = Math.sin(e.animT * 3 + e.seed) * 3;
  ctx.save();
  ctx.translate(0, hover);
  const a = Math.atan2(p.y - e.y, p.x - e.x);
  const ix = Math.cos(a) * 5, iy = Math.sin(a) * 5;
  ctx.save();
  ctx.translate(ix, iy);
  ctx.fillStyle = centeredRadial(ctx, 8, [[0, '#ff9ad5'], [1, '#8a2a5e']]);
  ctx.beginPath();
  ctx.arc(0, 0, 7.5, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1a0a14';
  ctx.beginPath();
  ctx.arc(ix, iy, 3.4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(ix - 2, iy - 2.4, 1.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// live charging glow for siren/warlock (baked frames are at-rest)
function drawCasterCharge(eng: Engine, ctx: CanvasRenderingContext2D, e: Enemy, p: Engine['player'], sc: number, bob: number) {
  ctx.save();
  ctx.translate(0, bob);
  ctx.scale(sc, sc);
  if (e.type === 'siren') {
    const hover = Math.sin(e.animT * 4 + e.seed) * 3;
    ctx.translate(0, hover);
    const charging = e.shootCd < 0.6;
    if (charging) {
      glow(ctx, 0, -2, 10 + Math.sin(eng.vt * 20) * 3, 'rgba(125,201,255,0.75)');
      ctx.fillStyle = '#eaf7ff';
      ctx.beginPath();
      ctx.ellipse(0, -2, 2.4, 4.9, 0, 0, TAU);
      ctx.fill();
      if (Math.random() < 0.4) {
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        eng.particles.spawn({ x: e.x, y: e.y - 4, vx: Math.cos(a) * 40 + (Math.random() * 30 - 15), vy: Math.sin(a) * 40 - 20, life: 0.5, size: 1.5 + Math.random() * 1.5, color: '#7dc9ff', mode: 'glow', drag: 0.95 });
      }
    }
  } else {
    // warlock: brighten the orbiting charge-orbs as the volley nears
    const charge = clamp(1 - e.shootCd / 1.2, 0, 1);
    if (charge > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const a = e.animT * 2.4 + (i / 3) * TAU;
        const ox = Math.cos(a) * 17, oy = Math.sin(a) * 8 - 22;
        const or = charge * 4;
        ctx.save();
        ctx.translate(ox, oy);
        ctx.fillStyle = centeredRadial(ctx, or + 0.5, [[0, '#ffd9f2'], [1, 'rgba(217,140,255,0)']]);
        ctx.beginPath();
        ctx.arc(0, 0, or + 0.5, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.restore();
}
