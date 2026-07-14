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
import { ENEMY_TYPES, MELEE_ANIM_DUR, BLINK_IN, PLAYER_HURT_DY, PLAYER_HURT_R, STEP, BOSS_RAGE_START, BOSS_RAGE_FULL, LUCID_DUR, FINALE_ERUPT_DUR, FINALE_FALL_DUR, FINALE_DAWN_DUR } from './engine';
import { TAU, clamp, serpentPoint, type Enemy, type Zone, type Projectile, type BossProjectile, type Beam, type Bolt, type Gem, type Pickup } from './world';
import { ENEMY_SPRITES, enemyFrameId, wizardFrameId, darkWizardFrameId, WIZARD_FRAMES, WIZARD_CY, getWizardSkin, type AtlasEntry } from './enemySprites';
import { SHAPE_RING, SHAPE_DISC, SHAPE_SPIRAL, SHAPE_CAPSULE, type QuadList, type ShapeList } from './worldGPU';
import { drawStats } from './perf';
import { settings } from './settings';

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const _serp = { x: 0, y: 0 }; // scratch for serpent spine sampling

// --ui-scale read for banners/veils: getComputedStyle every frame allocates and
// forces style resolution, so the value is cached briefly (it only changes on
// resize, and a 300ms lag on a zoom change is invisible)
let _uiScale = 1;
let _uiScaleAt = -1;
function uiScale(): number {
  const now = performance.now();
  if (now - _uiScaleAt > 300) {
    _uiScaleAt = now;
    _uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  }
  return _uiScale;
}

// generic colour parse → [r,g,b,a] 0..1 (cached). The alpha of rgba() strings
// MUST be honoured: effects authored as rgba(...,0.5) render at double
// strength if the alpha is dropped.
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
    if (octx) { octx.save(); octx.scale(1 / eng.viewScale, 1 / eng.viewScale); eng.perf.draw(octx, eng.perf.viewW); octx.restore(); }
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
  // During the Other Dreamer's scene the player's spells recede to a whisper so
  // the duel reads clean — every offensive/defensive layer fades as one group,
  // while pickups, the wizard, enemies and the Dreamer's own bolts stay full.
  const sv = eng.spellVisibility;
  q.groupAlpha = sv; sh.groupAlpha = sv;
  for (const z of eng.zones) emitZone(sh, q, eng, z, alpha, camX, camY, lanternDim);
  for (const b of eng.beams) emitBeam(sh, eng, b, alpha, camX, camY);
  for (const b of eng.bolts) emitBolt(sh, b, alpha, camX, camY);
  q.groupAlpha = 1; sh.groupAlpha = 1;
  for (const s of eng.pickups) emitPickup(q, eng, s, camX, camY);
  for (const g of eng.gems) emitGem(q, cam, g, alpha, camX, camY);
  sh.groupAlpha = sv;
  emitDefenseUnder(sh, eng, ipx - camX, ipy - camY);
  sh.groupAlpha = 1;
  emitFinale(q, sh, shOver, eng, alpha, camX, camY);
  emitPlayer(q, eng, ipx - camX, ipy - camY);
  for (const e of eng.enemies) emitEnemy(q, shOver, eng, e, alpha, camX, camY);
  q.groupAlpha = sv;
  emitOrbitals(q, eng, alpha, camX, camY);
  emitFrostOrbs(q, eng, alpha, camX, camY);
  emitWisps(q, eng, alpha, camX, camY);
  emitDefenseOver(q, eng, ipx - camX, ipy - camY);
  for (const pr of eng.projectiles) emitProjectile(q, eng, pr, alpha, camX, camY);
  q.groupAlpha = 1;
  for (const bp of eng.bossProjectiles) emitBossProjectile(q, sh, eng, bp, alpha, camX, camY);
  emitParticles(q, eng, camX, camY);

  // the dreamscape strays further into psychedelia, then horror, the deeper
  // (longer) a dream runs — one mood stage per 5 minutes; nil on the menu sky.
  const mood = eng.inRun ? eng.t / 300 : 0;
  world.render(vt, camX, camY, sh, q, shOver, eng.corruption, mood, ipx, ipy);
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

  // guide arrows toward fallen stars — orbiting just outside the player,
  // where the eye already lives, and pointing the way until the star is
  // actually reached (fading out on final approach so it never sits on it)
  for (const s of eng.pickups) {
    const dx = s.x - ipx, dy = s.y - ipy;
    const d = Math.hypot(dx, dy);
    const near = clamp((d - 110) / 130, 0, 1);
    if (near <= 0) continue;
    const ang = Math.atan2(dy, dx);
    const pulse = 0.5 + 0.5 * Math.sin(vt * 5);
    // the arrow surges toward the star each pulse — motion draws the eye
    // better than size, so it breathes hard while staying small
    const orbitR = 80 + 12 * pulse;
    const ax = ipx - camX + Math.cos(ang) * orbitR;
    const ay = ipy - camY + Math.sin(ang) * orbitR;
    const arrowC = s.kind === 'altar' ? '#c48cff' : '#7ff5ff';
    octx.save();
    octx.translate(ax, ay);
    octx.rotate(ang);
    // size tracks the actual distance across a wide band, so the chevron is
    // largest when the star is far off and grows steadily smaller the whole way
    // in — not just at the very end
    const sizeF = clamp((d - 110) / 480, 0, 1);
    const sc = (0.92 + 0.12 * pulse) * (0.5 + 0.8 * sizeF);
    octx.scale(sc, sc);
    octx.globalAlpha = near * (0.92 + 0.08 * pulse);
    // the star, trailing behind the chevron
    octx.fillStyle = arrowC;
    octx.shadowColor = arrowC;
    octx.shadowBlur = 18;
    octx.beginPath();
    octx.arc(-13, 0, 3.6, 0, Math.PI * 2);
    octx.fill();
    // chevron with a dark rim so it survives bright backdrops
    octx.beginPath();
    octx.moveTo(16, 0);
    octx.lineTo(-8, -9);
    octx.lineTo(-3.5, 0);
    octx.lineTo(-8, 9);
    octx.closePath();
    octx.shadowBlur = 0;
    octx.lineJoin = 'round';
    octx.lineWidth = 4;
    octx.strokeStyle = 'rgba(6,4,16,0.85)';
    octx.stroke();
    octx.shadowBlur = 18;
    octx.fill();
    octx.restore();
  }

  // guide arrow toward a golden wisp — it flits in fast and flees, so a gold
  // chevron near the player marks the way to chase it down before it escapes.
  // Fades out on close approach so it never sits on top of the wisp.
  for (const gw of eng.enemies) {
    if (!gw.golden || gw.dead) continue;
    const gx = lerp(gw.px, gw.x, alpha), gy = lerp(gw.py, gw.y, alpha);
    const dx = gx - ipx, dy = gy - ipy;
    const d = Math.hypot(dx, dy);
    const near = clamp((d - 120) / 140, 0, 1);
    if (near <= 0) continue;
    const ang = Math.atan2(dy, dx);
    const pulse = 0.5 + 0.5 * Math.sin(vt * 6);
    const orbitR = 92 + 14 * pulse;
    const ax = ipx - camX + Math.cos(ang) * orbitR;
    const ay = ipy - camY + Math.sin(ang) * orbitR;
    const arrowC = '#ffd27a';
    octx.save();
    octx.translate(ax, ay);
    octx.rotate(ang);
    // size tracks distance across a wide band — largest when the wisp is far,
    // shrinking steadily the whole way in
    const sizeF = clamp((d - 120) / 500, 0, 1);
    const sc = (0.95 + 0.14 * pulse) * (0.5 + 0.8 * sizeF);
    octx.scale(sc, sc);
    octx.globalAlpha = near * (0.92 + 0.08 * pulse);
    // a golden mote trailing behind the chevron
    octx.fillStyle = arrowC;
    octx.shadowColor = arrowC;
    octx.shadowBlur = 18;
    octx.beginPath();
    octx.arc(-13, 0, 3.8, 0, Math.PI * 2);
    octx.fill();
    // chevron with a dark rim so it survives bright backdrops
    octx.beginPath();
    octx.moveTo(16, 0);
    octx.lineTo(-8, -9);
    octx.lineTo(-3.5, 0);
    octx.lineTo(-8, 9);
    octx.closePath();
    octx.shadowBlur = 0;
    octx.lineJoin = 'round';
    octx.lineWidth = 4;
    octx.strokeStyle = 'rgba(6,4,16,0.85)';
    octx.stroke();
    octx.shadowBlur = 18;
    octx.fill();
    octx.restore();
  }

  // guide arrows toward the dream-motes while the Other Dreamer is veiled —
  // the same chevron language as the golden wisp, in the motes' warm gold
  if (eng.finale.veiled) {
    for (const m of eng.finale.motes) {
      if (m.got) continue;
      const dx = m.x - ipx, dy = m.y - ipy;
      const d = Math.hypot(dx, dy);
      const near = clamp((d - 90) / 120, 0, 1);
      if (near <= 0) continue;
      const ang = Math.atan2(dy, dx);
      const pulse = 0.5 + 0.5 * Math.sin(vt * 7 + m.ph);
      const orbitR = 84 + 12 * pulse;
      const ax = ipx - camX + Math.cos(ang) * orbitR;
      const ay = ipy - camY + Math.sin(ang) * orbitR;
      octx.save();
      octx.translate(ax, ay);
      octx.rotate(ang);
      const sizeF = clamp((d - 90) / 480, 0, 1);
      const sc = (0.9 + 0.14 * pulse) * (0.5 + 0.8 * sizeF);
      octx.scale(sc, sc);
      octx.globalAlpha = near * (0.9 + 0.1 * pulse);
      octx.fillStyle = '#ffd27a';
      octx.shadowColor = '#ffd27a';
      octx.shadowBlur = 18;
      octx.beginPath();
      octx.arc(-13, 0, 3.6, 0, Math.PI * 2);
      octx.fill();
      octx.beginPath();
      octx.moveTo(16, 0);
      octx.lineTo(-8, -9);
      octx.lineTo(-3.5, 0);
      octx.lineTo(-8, 9);
      octx.closePath();
      octx.shadowBlur = 0;
      octx.lineJoin = 'round';
      octx.lineWidth = 4;
      octx.strokeStyle = 'rgba(6,4,16,0.85)';
      octx.stroke();
      octx.shadowBlur = 18;
      octx.fill();
      octx.restore();
    }
  }

  // event banner — sits BELOW the HUD's clock/kill-counter block, and follows
  // the DOM UI's --ui-scale so it stays clear of the (zoomed) HUD and keeps
  // its proportions on high-res displays (the canvas itself is never zoomed)
  if (eng.banner) {
    const b = eng.banner;
    const a = Math.min(1, b.life, (b.maxLife - b.life) * 3);
    const uiS = uiScale();
    const bSize = (b.size || 24) * uiS;
    octx.save();
    // banner is screen-space (follows --ui-scale, not the world zoom)
    octx.scale(1 / eng.viewScale, 1 / eng.viewScale);
    octx.globalAlpha = a;
    octx.textAlign = 'center';
    // event banners speak in the UI's engraved display face
    octx.font = `700 ${bSize}px Cinzel, 'Palatino Linotype', serif`;
    // tracked capitals, where the engine supports it (reset by restore())
    try { (octx as unknown as { letterSpacing: string }).letterSpacing = '0.12em'; } catch { /* older engines */ }
    octx.fillStyle = b.color;
    octx.shadowColor = b.color;
    octx.shadowBlur = (18 + (b.size > 24 ? 14 : 0)) * uiS;
    // the Other Dreamer's plate owns the band under the clock — banners drop
    // below it while he lives, so his name/state never collide with an event
    const plated = eng.finale.phase === 'boss' ? 62 : 0;
    octx.fillText(b.str, eng.perf.viewW / 2, (176 + plated + ((b.size || 24) - 24) * 0.6) * uiS);
    octx.restore();
  }

  // the dream turns lucid: a breathing cyan veil + drifting motes for the whole
  // window, so the slowed horde and doubled essence are *felt*, not just captioned
  if (eng.lucidT > 0) drawLucidVeil(octx, w, h, eng.lucidT, vt);

  // the fifteenth minute: letterbox, creeping vignette, the two spoken lines
  drawFinaleOverlay(eng, octx, w, h, vt, camX, camY);

  if (eng.flash) {
    octx.fillStyle = `rgba(${eng.flash.color},${Math.max(0, eng.flash.a)})`;
    octx.fillRect(0, 0, w, h);
  }

  // perf overlay always sits on the topmost 2D layer, in screen (css-px) space
  octx.save();
  octx.scale(1 / eng.viewScale, 1 / eng.viewScale);
  eng.perf.draw(octx, eng.perf.viewW);
  octx.restore();
}

// Lucid-moment overlay: a cool wash, a breathing vignette, rising dream-motes and
// a persistent line naming the boon. Fades in over the first half-second and out
// over the last, so the whole 6s reads as a distinct, dreamy altered state.
function drawLucidVeil(octx: CanvasRenderingContext2D, w: number, h: number, lucidT: number, vt: number) {
  const a = Math.min(clamp((LUCID_DUR - lucidT) / 0.5, 0, 1), clamp(lucidT / 1.2, 0, 1));
  if (a <= 0) return;
  const pulse = 0.5 + 0.5 * Math.sin(vt * 2.2);
  octx.save();
  // a faint cool wash cools the whole dream
  octx.fillStyle = `rgba(125,245,255,${0.05 * a})`;
  octx.fillRect(0, 0, w, h);
  // breathing cyan vignette drawn from the edges inward
  const g = octx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, 'rgba(127,245,255,0)');
  g.addColorStop(1, `rgba(127,245,255,${(0.16 + 0.08 * pulse) * a})`);
  octx.fillStyle = g;
  octx.fillRect(0, 0, w, h);
  // rising dream-motes: slow, twinkling, wrapping up the screen
  octx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 16; i++) {
    const mx = (i * 97.13 + vt * (6 + (i % 4) * 3)) % w;
    const my = h - ((i * 61.7 + vt * (16 + (i % 5) * 6)) % (h + 60));
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(vt * 3 + i * 1.7));
    const r = 1.4 + (i % 3) * 0.8;
    octx.fillStyle = `rgba(205,250,255,${0.55 * tw * a})`;
    octx.beginPath(); octx.arc(mx, my, r, 0, Math.PI * 2); octx.fill();
  }
  octx.globalCompositeOperation = 'source-over';
  // name the boon, held for the whole window so its effect is unmistakable
  const uiS = uiScale();
  octx.globalAlpha = a * 0.92;
  octx.textAlign = 'center';
  octx.font = `600 ${13 * uiS}px Cinzel, 'Palatino Linotype', serif`;
  try { (octx as unknown as { letterSpacing: string }).letterSpacing = '0.16em'; } catch { /* older engines */ }
  octx.fillStyle = '#dffcff';
  octx.shadowColor = '#7ff5ff';
  octx.shadowBlur = 12 * uiS;
  octx.fillText('THE HORDE CRAWLS · ESSENCE FLOWS TWOFOLD', w / 2, 206 * uiS);
  octx.restore();
}

// ================================================== the fifteenth minute
// World-space pieces of the finale: the dark wizard cutscene actor, the
// nightmare's rift telegraphs, his veil, the dream-motes and the lunge line.
function emitFinale(q: QuadList, sh: ShapeList, shOver: ShapeList, eng: Engine, alpha: number, camX: number, camY: number) {
  const F = eng.finale;
  if (F.phase === 'none' || F.phase === 'done') return;
  const vt = eng.vt;
  const glowE = q.uv('glow')!;

  // ---- the dark wizard, before he turns ----
  if (F.phase === 'approach' || F.phase === 'line1' || F.phase === 'line2' || F.phase === 'dread' || F.phase === 'anger') {
    const wx = lerp(F.wpx, F.wx, alpha) - camX;
    const wy = lerp(F.wpy, F.wy, alpha) - camY;
    // mostly solid, with sudden drops — a presence the dream can't quite hold
    const fl = Math.sin(vt * 31.7) * Math.sin(vt * 17.3);
    let a = 0.94 + 0.06 * Math.sin(vt * 9);
    if (fl > 0.93) a *= 0.35;
    const angerF = F.phase === 'anger' ? Math.min(1, F.t / 2.4) : 0;
    const grow = 1 + angerF * 0.55;
    const jit = angerF * 5;
    const jx = wx + (Math.random() * 2 - 1) * jit;
    const jy = wy + (Math.random() * 2 - 1) * jit * 0.6;
    // ground shadow + an anti-light pooled around him
    q.push(false, glowE, jx, jy + 8, 24 * grow, 0, 0.5, 0.01, 0, 0.02, 1, 0.3);
    q.push(false, glowE, jx, jy - 24 * grow, 52 * grow, 0, 0.45 * a, 0.05, 0.01, 0.05, 1);
    let fi = ((F.animT * 6) / TAU * WIZARD_FRAMES) | 0;
    fi = ((fi % WIZARD_FRAMES) + WIZARD_FRAMES) % WIZARD_FRAMES;
    const wizE = q.uv(darkWizardFrameId(fi));
    if (wizE) {
      const mirrored = F.facing < 0;
      q.push(false, wizE, jx, jy - WIZARD_CY * grow, wizE.half * grow, 0, a, 1, 1, 1, 0, 1, mirrored);
    }
    // eyes that answer in red
    const ex = jx + 3.4 * F.facing * grow;
    const ey = jy - 33 * grow;
    q.push(true, glowE, ex, ey, 6.5 * grow, 0, 0.8 * a, 1, 0.13, 0.25, 1);
    q.push(true, glowE, ex, ey, 2.4 * grow, 0, a, 1, 0.55, 0.6, 1);
    // his staff orb, burning the wrong colour
    const ox = jx + 14 * F.facing * grow;
    const oy = jy - 48 * grow;
    q.push(true, glowE, ox, oy, (10 + Math.sin(vt * 3.2) * 2 + angerF * 8) * grow, 0, 0.75 * a, 1, 0.13, 0.25, 1);
    q.push(true, glowE, ox, oy, 4 * grow, 0, a, 1, 0.84, 0.87, 1);
  }

  // ---- his unmaking: the dream-glass he is made of cracks, then shatters ----
  // His frozen form is sliced into a grid of sub-UV quads; a crack wave spreads
  // from the wound in his chest, and each fragment breaks free in turn — flung
  // out, tumbling, falling, flushing to gold, catching the light like glass.
  if (F.phase === 'fall') {
    const wx = F.wx - camX, wy = F.wy - camY;
    const f = Math.min(1, F.t / FINALE_FALL_DUR);
    const sc = 2; // his boss scale (radius 66 / base 33)
    const SHATTER_T0 = 1.0;   // the figure holds, cracking, until here
    const CRACK_SPREAD = 1.2; // seconds for the crack to reach the far edges
    const FLIGHT_FADE = 1.8;  // a freed piece's life once it breaks away

    const nf = ENEMY_SPRITES.nightmare.frames;
    const fi = (nf * 0.5) | 0; // one frozen pose — the pieces are slices of it
    const nmE = q.uv(enemyFrameId('nightmare', fi));
    if (nmE) {
      const half = nmE.half * sc;
      const ox = 0, oy = -0.28 * half;          // crack origin: the chest wound
      const maxD = Math.hypot(half * 1.05, half * 1.3);

      if (F.t < SHATTER_T0) {
        // whole, and cracking: a rising tremor and jagged seams of light crawling
        // out from the wound. He stays himself — no gold wash — until he breaks.
        const cf = F.t / SHATTER_T0;
        const jit = cf * cf * 3;
        const jx = wx + (Math.random() * 2 - 1) * jit;
        const jy = wy + (Math.random() * 2 - 1) * jit * 0.5;
        q.push(false, nmE, jx, jy, half, Math.sin(vt * 5) * 0.02 * cf, 1, 1, 0.95, 0.7, cf * 0.12);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * TAU + fhash(k) * 1.2;
          const len = (0.25 + cf * 1.0) * half;
          shOver.push(SHAPE_CAPSULE, wx + ox, wy + oy, a, len, 0.8 + cf * 1.6, 5, 0, 1, 0.97, 0.8, 0.4 + 0.45 * cf, 1, 0.88, 0.5);
        }
        q.push(true, glowE, wx + ox, wy + oy, (7 + cf * 22), 0, 0.3 + 0.45 * cf, 1, 0.9, 0.62, 1);
      } else {
        // shattered: every slice of his ACTUAL sprite as its own tumbling piece —
        // real pixels, only a touch of warm light so they read against the (now
        // draining) dark sky, plus a faint lift in each piece's own shape
        const COLS = 5, ROWS = 6;
        const cellHalf = half / COLS;
        const asp = COLS / ROWS;
        const du = (nmE.u1 - nmE.u0) / COLS, dv = (nmE.v1 - nmE.v0) / ROWS;
        for (let cyi = 0; cyi < ROWS; cyi++) {
          for (let cxi = 0; cxi < COLS; cxi++) {
            const lx = ((cxi + 0.5) / COLS - 0.5) * 2 * half;
            const ly = ((cyi + 0.5) / ROWS - 0.5) * 2 * half;
            const tb = SHATTER_T0 + (Math.hypot(lx - ox, ly - oy) / maxD) * CRACK_SPREAD;
            const ent: AtlasEntry = { u0: nmE.u0 + cxi * du, v0: nmE.v0 + cyi * dv, u1: nmE.u0 + (cxi + 1) * du, v1: nmE.v0 + (cyi + 1) * dv, half: cellHalf };
            if (F.t < tb) {
              // still assembled (reconstructing the whole figure), the fracture
              // about to reach it kindling along its edge
              const near = Math.max(0, 1 - (tb - F.t) / 0.2);
              q.push(false, ent, wx + lx, wy + ly, cellHalf, 0, 1, 1, 0.95, 0.7, near * 0.35, asp);
              if (near > 0) q.push(true, ent, wx + lx, wy + ly, cellHalf, 0, near * 0.5, 1, 0.9, 0.6, 1, asp);
            } else {
              const dt2 = F.t - tb;
              const a = Math.min(1, 1 - dt2 / FLIGHT_FADE);
              if (a <= 0.02) continue;
              const h1 = fhash(cyi * COLS + cxi), h2 = fhash(cyi * COLS + cxi + 131);
              const dir = Math.atan2(ly - oy, lx - ox) + (h1 - 0.5) * 0.8;
              const sp = 55 + h2 * 150;
              const gx = wx + lx + Math.cos(dir) * sp * dt2;
              const gy = wy + ly + Math.sin(dir) * sp * dt2 + 120 * dt2 * dt2;
              const rot = (h1 - 0.5) * 10 * dt2;
              // the real piece, warm-lit and tumbling
              q.push(false, ent, gx, gy, cellHalf, rot, a, 1, 0.85, 0.62, 0.26, asp);
              // a faint gold lift in the piece's OWN shape (not a round glow), so
              // it separates from the dark without becoming a blob
              q.push(true, ent, gx, gy, cellHalf, rot, a * 0.3, 1, 0.86, 0.55, 1, asp);
            }
          }
        }
      }

      // a soft warm afterglow where he stood, rising once the pieces are gone
      if (f > 0.55) {
        const rf = (f - 0.55) / 0.45;
        q.push(true, glowE, wx, wy - 8 - rf * 40, 20 + rf * 40, 0, rf * (1 - rf) * 2.2, 1, 0.9, 0.62, 1);
      }
    }
  }

  // ---- rift telegraphs: red wounds tearing open, tightening to the eruption ----
  for (const hz of F.hazards) {
    const x = hz.x - camX, y = hz.y - camY;
    const f = 1 - Math.max(0, hz.t) / hz.max; // 0 → 1 toward eruption
    const pulse = 0.5 + 0.5 * Math.sin(vt * (6 + f * 18));
    sh.push(SHAPE_DISC, x, y, 0, hz.r, 0.6, 1.2, 0, 0.10, 0.01, 0.04, (0.25 + 0.45 * f) * (0.7 + 0.3 * pulse), 0.30 * f, 0.02, 0.07, false);
    sh.push(SHAPE_RING, x, y, vt * 1.4, hz.r, 1.8, 7, 0.35, 1, 0.13, 0.25, 0.35 + 0.6 * f, 0.4 * f, 0.03, 0.08);
    sh.push(SHAPE_RING, x, y, 0, hz.r * (1 - f * 0.85), 1.4, 5, 0, 1, 0.35, 0.4, 0.5 + 0.5 * f, 0.3, 0.05, 0.1);
  }

  const boss = F.boss;
  if (boss && !boss.dead) {
    const bx = lerp(boss.px, boss.x, alpha) - camX;
    const by = lerp(boss.py, boss.y, alpha) - camY;
    // the lunge line, sharpening as the wind-up locks
    if (F.dash === 1) {
      const f2 = 1 - Math.max(0, F.dashT) / F.dashMax;
      shOver.push(SHAPE_CAPSULE, bx, by, F.dashA, 900, 6 + f2 * 8, 10, 0, 1, 0.13, 0.25, 0.12 + 0.3 * f2, 0.25 * f2, 0.02, 0.06);
      shOver.push(SHAPE_CAPSULE, bx, by, F.dashA, 900, 1.5, 4, 0, 1, 0.5, 0.55, 0.3 + 0.5 * f2, 0.3 * f2, 0.05, 0.1);
    }
    // the veil: a bruise-dark shell laced with red
    if (F.veiled) {
      const breath = 0.5 + 0.5 * Math.sin(vt * 2.2);
      const R = boss.radius + 26 + breath * 6;
      sh.push(SHAPE_DISC, bx, by, 0, R, 0.7, 1.4, 0, 0.06, 0.01, 0.05, 0.55, 0.10, 0.01, 0.06, false);
      sh.push(SHAPE_RING, bx, by, vt * 0.9, R, 2.2, 9, 0.25, 1, 0.13, 0.25, 0.6 + 0.3 * breath, 0.35, 0.04, 0.10);
      sh.push(SHAPE_RING, bx, by, -vt * 1.6, R * 0.82, 1.4, 6, 0.6, 0.55, 0.06, 0.16, 0.5, 0.2, 0.02, 0.06);
    }
    // stunned: golden light pouring through the cracks — strike NOW
    if (F.stunT > 0) {
      const flick = 0.5 + 0.5 * Math.sin(vt * 14);
      sh.push(SHAPE_RING, bx, by, vt * 0.5, boss.radius + 12, 2, 8, 0, 1, 0.82, 0.48, 0.5 + 0.4 * flick, 0.4, 0.3, 0.12);
      q.push(true, glowE, bx, by - boss.radius * 0.3, boss.radius * 0.9, 0, 0.18 + 0.15 * flick, 1, 0.82, 0.48, 1);
    }
  }

  // ---- the stolen light: dream-motes to gather while he is veiled ----
  if (F.veiled) {
    const starE = q.uv('pickup:star')!;
    const beaconE = q.uv('pickup:beacon')!;
    const ringE = q.uv('ring')!;
    const urgent = F.moteT < 4 ? 0.5 + 0.5 * Math.sin(vt * 10) : 1;
    const mS = 1.4; // bigger, easier to grab while sprinting after them
    for (const m of F.motes) {
      if (m.got) continue;
      const x = m.x - camX, y = m.y - camY + Math.sin(m.ph) * 4;
      q.push(true, beaconE, x, y, beaconE.half * mS, 0, 0.9 * urgent, 1, 0.82, 0.48, 1);
      q.push(true, ringE, x, y + 6, (12 + Math.sin(vt * 4) * 2) * mS / 30 * ringE.half, 0, 0.6 * urgent, 1, 0.82, 0.48, 1);
      q.push(true, glowE, x, y - 8, 30 * mS, 0, urgent, 1, 0.82, 0.48, 1);
      q.push(true, starE, x, y - 8, starE.half * mS, m.ph * 0.7, urgent, 1, 0.9, 0.6, 1);
    }
  }

  // ---- the collapse: golden calm marked in the world; the red doom itself
  // is shaded on the overlay (drawFinaleOverlay), where it can cut holes ----
  const col = F.collapse;
  if (col) {
    const f = 1 - Math.max(0, col.t) / col.max;
    const pulse = 0.5 + 0.5 * Math.sin(vt * (5 + f * 14));
    const eruptF = col.erupt > 0 ? col.erupt / FINALE_ERUPT_DUR : 0;
    // the gold calm flares bright the instant the doom fires — being safe is a
    // reward you SEE, the opposite pole from the red glare over the doomed ground
    const gA = (0.55 + 0.45 * pulse) * (1 + eruptF * 2.1);
    const eBloom = eruptF * eruptF; // the interior fills with gold light on the beat
    if (col.kind === 'islands') {
      for (const isl of col.islands) {
        const x = isl.x - camX, y = isl.y - camY;
        sh.push(SHAPE_RING, x, y, vt * 0.8, isl.r, 2.2 + 3.4 * eruptF, 9, 0, 1, 0.82, 0.48, gA, 0.4, 0.3, 0.12);
        sh.push(SHAPE_DISC, x, y, 0, isl.r * 0.94, 0.7, 1.4, 0, 1, 0.86, 0.54, 0.08 + 0.08 * pulse + 0.4 * eBloom, 0.22, 0.16, 0.06);
        const beaconE = q.uv('pickup:beacon')!;
        q.push(true, beaconE, x, y, beaconE.half, 0, 0.5 * gA, 1, 0.82, 0.48, 1);
      }
    } else if (col.kind === 'band') {
      const x = col.cx - camX, y = col.cy - camY;
      sh.push(SHAPE_RING, x, y, vt * 0.5, col.r0, 2.2 + 3.4 * eruptF, 9, 0, 1, 0.82, 0.48, gA, 0.4, 0.3, 0.12);
      sh.push(SHAPE_RING, x, y, -vt * 0.5, col.r1, 2.2 + 3.4 * eruptF, 9, 0, 1, 0.82, 0.48, gA, 0.4, 0.3, 0.12);
      sh.push(SHAPE_RING, x, y, 0, (col.r0 + col.r1) / 2, (col.r1 - col.r0) * 0.42, 4, 0, 1, 0.86, 0.54, 0.06 + 0.06 * pulse + 0.32 * eBloom, 0.14, 0.10, 0.04);
    } else if (col.kind === 'halves') {
      // halves: the boundary seam, with a breath of gold on the safe side
      const ca2 = Math.cos(col.halfA), sa2 = Math.sin(col.halfA);
      const nx = -sa2, ny = ca2; // the safe normal
      const x0 = col.cx - ca2 * 1600 - camX, y0 = col.cy - sa2 * 1600 - camY;
      shOver.push(SHAPE_CAPSULE, x0, y0, col.halfA, 3200, 2.4 + 4 * eruptF, 10, 0, 1, 0.82, 0.48, gA, 0.45, 0.34, 0.14);
      for (let i = -4; i <= 4; i++) {
        const bx2 = col.cx + ca2 * i * 190 + nx * 130 - camX;
        const by2 = col.cy + sa2 * i * 190 + ny * 130 - camY;
        q.push(true, glowE, bx2, by2, 26 + pulse * 8 + 22 * eBloom, 0, 0.16 + 0.12 * pulse + 0.4 * eBloom, 1, 0.86, 0.54, 1);
      }
    } else {
      // doom: the island telegraph's shape rendered in wrathful red — these are
      // not havens but wells, and (see drawCollapseDanger) the whole floor burns
      const dA = (0.6 + 0.4 * pulse) * (1 + eruptF * 2.4);
      for (const isl of col.islands) {
        const x = isl.x - camX, y = isl.y - camY;
        sh.push(SHAPE_RING, x, y, -vt * 1.1, isl.r, 2.6 + 4 * eruptF, 10, 0, 1, 0.18, 0.24, dA, 0.5, 0.04, 0.1);
        sh.push(SHAPE_DISC, x, y, 0, isl.r * 0.96, 0.7, 1.3, 0, 1, 0.12, 0.18, 0.12 + 0.14 * pulse + 0.5 * eBloom, 0.4, 0.03, 0.08);
      }
    }
  }
}

// Screen-space finale layer: letterbox bars during the scene, a creeping
// vignette that never fully lifts while the Other Dreamer lives, the two
// spoken lines, and the mote-timer while he is veiled.
function drawFinaleOverlay(eng: Engine, octx: CanvasRenderingContext2D, w: number, h: number, vt: number, camX: number, camY: number) {
  const F = eng.finale;
  const ph = F.phase;
  if (ph === 'none' || ph === 'done') return;

  // creeping vignette — the dream going wrong at its edges
  let dark = 0;
  if (ph === 'sweep') dark = Math.min(1, F.t / 1.6) * 0.35;
  else if (ph === 'approach' || ph === 'line1') dark = 0.35;
  else if (ph === 'line2') dark = 0.45;
  else if (ph === 'dread' || ph === 'anger') dark = 0.6;
  else if (ph === 'boss') dark = 0.3;
  if (dark > 0) {
    const g = octx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(10,0,8,0)');
    g.addColorStop(1, `rgba(10,0,8,${0.75 * dark})`);
    octx.fillStyle = g;
    octx.fillRect(0, 0, w, h);
  }

  if (ph === 'boss') {
    drawCollapseDanger(eng, octx, w, h, vt, camX, camY);
    // above the doom wash, always readable. The gather countdown lives on the
    // plate now — one place to look, instead of two saying the same thing.
    drawFinaleBossBar(eng, octx, vt, 1);
    return;
  }

  // his fall and the dawn: a warm wash blooms over everything as the dream is
  // handed back, then eases; the letterbox holds through the fall and retracts
  // as ordinary daylight returns
  if (ph === 'fall' || ph === 'dawn') {
    // his plate holds a beat at empty, then fades with him
    if (ph === 'fall' && F.t < 1.2) drawFinaleBossBar(eng, octx, vt, Math.max(0, 1 - F.t / 1.2));
    const bloom = ph === 'fall'
      ? Math.max(0, F.t / FINALE_FALL_DUR - 0.5) * 0.5
      : Math.max(0, 1 - F.t / (FINALE_DAWN_DUR * 0.7)) * 0.6 + 0.1;
    if (bloom > 0.01) {
      const g = octx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.8);
      g.addColorStop(0, `rgba(255,244,214,${Math.min(0.85, bloom)})`);
      g.addColorStop(0.5, `rgba(255,226,180,${Math.min(0.5, bloom * 0.6)})`);
      g.addColorStop(1, 'rgba(255,214,160,0)');
      octx.fillStyle = g;
      octx.fillRect(0, 0, w, h);
    }
    const bar = ph === 'fall' ? 1 : Math.max(0, 1 - F.t / FINALE_DAWN_DUR);
    const barH = h * 0.11 * bar;
    if (barH > 0.5) {
      octx.fillStyle = `rgba(4,2,8,${0.92 * (ph === 'fall' ? 1 : bar)})`;
      octx.fillRect(0, 0, w, barH);
      octx.fillRect(0, h - barH, w, barH);
    }
    return;
  }

  // cinematic letterbox
  const barIn = ph === 'sweep' ? Math.min(1, F.t / 1.2) : 1;
  const barH = h * 0.11 * barIn;
  octx.fillStyle = 'rgba(4,2,8,0.92)';
  octx.fillRect(0, 0, w, barH);
  octx.fillRect(0, h - barH, w, barH);

  // the spoken lines, floating over their speakers
  let str = '', lx = 0, ly = 0, col = '#e6ecff', tt = 0, dur = 1, size = 19, shadow = '#8fb8ff';
  if (ph === 'line1') {
    str = '“What are you doing in my dream?”';
    lx = eng.player.x; ly = eng.player.y - 96; tt = F.t; dur = 3.0;
  } else if (ph === 'line2') {
    str = '“Your dream?”';
    lx = F.wx; ly = F.wy - 96; col = '#ff9aae'; tt = F.t; dur = 2.6; size = 22; shadow = '#ff2040';
  }
  if (str) {
    const a = Math.max(0, Math.min(1, tt * 4, (dur - tt) * 3));
    octx.save();
    octx.globalAlpha = a;
    octx.textAlign = 'center';
    octx.font = `600 ${size}px Cinzel, 'Palatino Linotype', serif`;
    octx.fillStyle = col;
    octx.shadowColor = shadow;
    octx.shadowBlur = 14;
    const jx = ph === 'line2' ? Math.sin(vt * 47) * 1.2 : 0; // his words don't sit still
    octx.fillText(str, lx - camX + jx, ly - camY);
    octx.restore();
  }

  // anger: red light strobing up through the floor of the dream
  if (ph === 'anger') {
    const f = Math.min(1, F.t / 2.4);
    octx.fillStyle = `rgba(255,20,50,${0.08 + 0.12 * f * (0.5 + 0.5 * Math.sin(vt * 20))})`;
    octx.fillRect(0, 0, w, h);
  }
}

// A chamfered slab — his bar is a cut plate of dream-glass, not a rectangle.
function platePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cut: number) {
  ctx.beginPath();
  ctx.moveTo(x - cut, y + h / 2);
  ctx.lineTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w + cut, y + h / 2);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

// The Other Dreamer's plate: the only boss in the game with a bar of his own.
// Drawn in SCREEN (css-px) space, exactly like the event banner — the world-space
// version drifted down into the banner as viewScale grew.
//
// Everything about it is his: a chamfered slab bleeding ichor, veined with cracks
// that deepen as he's broken down, tearing sideways in glitch-bands (the same
// wrongness his silhouette has), scanlined like a corrupted signal, with his three
// red eyes set into each end-cap. The fill's leading edge is torn and boiling, and
// a pale chip trail bleeds behind it so heavy bursts read as a bite taken out of
// him. His two states are written into the bar itself: SEALED (with the gather
// countdown) while the veil holds damage off, and a gold, blazing STRIKE window
// the instant it shatters.
function drawFinaleBossBar(eng: Engine, octx: CanvasRenderingContext2D, vt: number, fade: number) {
  const F = eng.finale;
  const e = F.boss;
  const uiS = uiScale();
  const frac = e ? Math.max(0, e.hp) / e.maxHp : 0;
  const lag = e ? Math.max(frac, Math.min(1, F.hpLag / e.maxHp)) : 0;
  const veiled = F.veiled;
  const stun = F.stunT > 0;
  const rot = 1 - frac; // how far gone he is — the plate corrupts along with him

  octx.save();
  octx.scale(1 / eng.viewScale, 1 / eng.viewScale);
  const W = eng.perf.viewW;
  const bw = Math.min(W * 0.62, 740 * uiS);
  const bh = 28 * uiS;
  const bx = (W - bw) / 2;
  const by = 110 * uiS;
  const cut = bh * 0.55;
  const ls = (v: string) => { try { (octx as unknown as { letterSpacing: string }).letterSpacing = v; } catch { /* older engines */ } };
  const beat = 0.5 + 0.5 * Math.sin(vt * (stun ? 9 : 2.4));
  const hue = stun ? '255,210,122' : veiled ? '150,110,220' : '255,32,64';

  octx.globalAlpha = fade;

  // a sick bloom breathing behind the slab. Drawn as an ellipse in a squashed
  // frame and filled with its own arc — a radial gradient dropped into a short
  // fillRect gets clipped mid-falloff and leaves a hard rectangular seam.
  {
    const R = bw * 0.58;
    const sy = (bh * 2.1) / R; // a low, wide haze rather than a circle
    octx.save();
    octx.translate(W / 2, by + bh / 2);
    octx.scale(1, sy);
    const bloom = octx.createRadialGradient(0, 0, 0, 0, 0, R);
    bloom.addColorStop(0, `rgba(${hue},${0.15 + 0.07 * beat})`);
    bloom.addColorStop(0.45, `rgba(${hue},${0.05 + 0.03 * beat})`);
    bloom.addColorStop(1, `rgba(${hue},0)`);
    octx.fillStyle = bloom;
    octx.beginPath();
    octx.arc(0, 0, R, 0, TAU);
    octx.fill();
    octx.restore();
  }

  platePath(octx, bx, by, bw, bh, cut);
  octx.fillStyle = 'rgba(6,2,8,0.9)';
  octx.fill();

  // ---- everything that lives inside the slab
  octx.save();
  platePath(octx, bx, by, bw, bh, cut);
  octx.clip();

  if (lag > frac) {
    octx.fillStyle = 'rgba(255,160,180,0.45)';
    octx.fillRect(bx + bw * frac, by, bw * (lag - frac), bh);
  }

  // the fill, ending in a torn, boiling seam rather than a clean edge
  const fx = bx + bw * frac;
  const STEPS = 7;
  const seam = (i: number) => Math.sin(vt * 7 + i * 1.9) * 2.2 * uiS + (fhash(i) - 0.5) * 3 * uiS;
  const g = octx.createLinearGradient(bx, by, bx, by + bh);
  if (stun) { g.addColorStop(0, '#fff2cc'); g.addColorStop(0.45, '#ffb347'); g.addColorStop(1, '#8f5210'); }
  else if (veiled) { g.addColorStop(0, '#7a5884'); g.addColorStop(0.45, '#452c4d'); g.addColorStop(1, '#1c0f22'); }
  else { g.addColorStop(0, '#ff7090'); g.addColorStop(0.45, '#ff2040'); g.addColorStop(1, '#6e0a22'); }
  octx.fillStyle = g;
  octx.beginPath();
  octx.moveTo(bx - cut, by);
  octx.lineTo(fx, by);
  for (let i = 0; i <= STEPS; i++) octx.lineTo(fx + (frac > 0.002 ? seam(i) : 0), by + (bh * i) / STEPS);
  octx.lineTo(bx - cut, by + bh);
  octx.closePath();
  octx.fill();
  if (frac > 0.002) {
    octx.strokeStyle = stun ? 'rgba(255,250,235,0.95)' : 'rgba(255,220,232,0.85)';
    octx.lineWidth = 2 * uiS;
    octx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const yy = by + (bh * i) / STEPS;
      if (i === 0) octx.moveTo(fx + seam(i), yy); else octx.lineTo(fx + seam(i), yy);
    }
    octx.stroke();
  }

  // a corrupted signal: scanlines, then veins cracking through him
  octx.fillStyle = 'rgba(0,0,0,0.16)';
  for (let yy = by; yy < by + bh; yy += 3 * uiS) octx.fillRect(bx - cut, yy, bw + cut * 2, 1 * uiS);
  octx.strokeStyle = `rgba(18,0,6,${0.24 + rot * 0.4})`;
  octx.lineWidth = 1.2 * uiS;
  for (let k = 0; k < 7; k++) {
    let cxx = bx + bw * (0.08 + fhash(k * 3) * 0.86);
    octx.beginPath();
    octx.moveTo(cxx, by);
    for (let s = 1; s <= 4; s++) {
      cxx += (fhash(k * 7 + s) - 0.5) * 9 * uiS;
      octx.lineTo(cxx, by + (bh * s) / 4);
    }
    octx.stroke();
  }

  if (veiled) {
    octx.strokeStyle = 'rgba(206,170,255,0.22)';
    octx.lineWidth = 2 * uiS;
    for (let x = -bh; x < bw + bh; x += 11 * uiS) {
      octx.beginPath();
      octx.moveTo(bx + x, by + bh);
      octx.lineTo(bx + x + bh, by);
      octx.stroke();
    }
  }

  // the glitch: bands of him tear sideways, worse the more broken he is
  if (Math.random() < 0.06 + rot * 0.13) {
    const bands = 1 + ((Math.random() * 2) | 0);
    for (let b = 0; b < bands; b++) {
      const gy = by + Math.random() * bh;
      const gh = (2 + Math.random() * 5) * uiS;
      const dx = (Math.random() - 0.5) * 16 * uiS;
      octx.save();
      octx.beginPath();
      octx.rect(bx - cut, gy, bw + cut * 2, gh);
      octx.clip();
      octx.fillStyle = stun ? 'rgba(255,214,150,0.85)' : veiled ? 'rgba(150,110,190,0.8)' : 'rgba(255,60,90,0.85)';
      octx.fillRect(bx + dx, gy, bw * frac, gh);
      octx.restore();
    }
  }

  const sheen = octx.createLinearGradient(bx, by, bx, by + bh * 0.5);
  sheen.addColorStop(0, 'rgba(255,255,255,0.13)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  octx.fillStyle = sheen;
  octx.fillRect(bx - cut, by, bw + cut * 2, bh * 0.5);
  octx.restore();

  // ---- notches, and the heavy rail around it
  octx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 1; i < 10; i++) octx.fillRect(bx + (bw * i) / 10, by, 1 * uiS, bh);
  platePath(octx, bx, by, bw, bh, cut);
  octx.lineWidth = 3.5 * uiS;
  octx.strokeStyle = 'rgba(8,2,10,0.95)';
  octx.stroke();
  octx.lineWidth = 1.4 * uiS;
  octx.strokeStyle = stun ? `rgba(255,214,140,${0.85 + 0.15 * beat})` : veiled ? `rgba(190,150,255,${0.6 + 0.2 * beat})` : `rgba(255,70,104,${0.7 + 0.25 * beat})`;
  octx.shadowColor = stun ? '#ffd27a' : veiled ? '#b48cff' : '#ff2040';
  octx.shadowBlur = (10 + 8 * beat + (stun ? 12 : 0)) * uiS;
  octx.stroke();
  octx.shadowBlur = 0;

  // ---- his three eyes, set into each end-cap, blinking with the rail
  const eyeC = stun ? '#ffe6b0' : veiled ? '#c9a4ff' : '#ff2040';
  octx.fillStyle = eyeC;
  octx.shadowColor = eyeC;
  octx.shadowBlur = 8 * uiS;
  for (const side of [-1, 1]) {
    const ex = side < 0 ? bx - cut * 0.5 : bx + bw + cut * 0.5;
    const ey = by + bh / 2;
    for (const [ox2, oy2] of [[0, -5 * uiS], [-2.7 * uiS, 1 * uiS], [2.7 * uiS, 1 * uiS]]) {
      octx.beginPath();
      octx.arc(ex + ox2, ey + oy2, 1.7 * uiS * (0.85 + 0.3 * beat), 0, TAU);
      octx.fill();
    }
  }
  octx.shadowBlur = 0;

  // ---- ichor, bleeding from the underside — more of it as he comes apart
  octx.fillStyle = `rgba(120,10,32,${0.35 + rot * 0.3})`;
  const drips = 4 + ((rot * 6) | 0);
  for (let k = 0; k < drips; k++) {
    const dx = bx + bw * (0.06 + fhash(k * 11) * 0.88);
    const len = (4 + fhash(k * 5) * 10 + Math.sin(vt * 0.9 + k) * 3) * uiS * (0.55 + rot);
    if (len <= 0) continue;
    octx.fillRect(dx, by + bh, 1.6 * uiS, len);
    octx.beginPath();
    octx.arc(dx + 0.8 * uiS, by + bh + len, 1.7 * uiS, 0, TAU);
    octx.fill();
  }

  // ---- his name at the plate's left shoulder, his remains at its right
  // (both off-centre, so they never stack with the centred clock above)
  octx.textAlign = 'left';
  octx.font = `700 ${13 * uiS}px Cinzel, 'Palatino Linotype', serif`;
  ls('0.26em');
  octx.fillStyle = '#ffd3dc';
  octx.shadowColor = '#ff2040';
  octx.shadowBlur = 12 * uiS;
  octx.fillText('THE OTHER DREAMER', bx, by - 9 * uiS);
  octx.shadowBlur = 0;
  ls('0px');
  octx.textAlign = 'right';
  octx.font = `700 ${14 * uiS}px Cinzel, 'Palatino Linotype', serif`;
  octx.fillStyle = 'rgba(255,206,216,0.9)';
  octx.fillText(`${Math.ceil(frac * 100)}%`, bx + bw, by - 9 * uiS);

  // ---- and what the bar is telling you to DO, said inside the bar
  const urgent = veiled && F.moteT < 4;
  const label = stun ? 'THE VEIL BREAKS — STRIKE'
    : veiled ? `SEALED — GATHER THE LIGHT · ${Math.max(0, F.moteT).toFixed(1)}`
      : '';
  if (label) {
    const pulse = 0.7 + 0.3 * Math.sin(vt * (stun ? 12 : urgent ? 10 : 4));
    const col = stun ? '#fff6e0' : urgent ? '#ffd27a' : '#e6d1ff';
    octx.globalAlpha = fade * pulse;
    octx.textAlign = 'center';
    octx.font = `700 ${12 * uiS}px Cinzel, 'Palatino Linotype', serif`;
    ls('0.2em');
    octx.fillStyle = col;
    octx.shadowColor = col;
    octx.shadowBlur = 12 * uiS;
    octx.fillText(label, W / 2, by + bh / 2 + 4.5 * uiS);
  }
  octx.restore();
}

// The collapse's doom shading: everything unsafe reddens toward the eruption,
// with the golden calm cut out of the wash. Composited on a cached quarter-res
// canvas (the shapes are soft — upscaling is invisible) so destination-out
// hole-cutting never erases the overlay's own text/bars, then a single guide
// chevron points the shortest way into the calm while the dreamer is exposed.
let _dangerC: HTMLCanvasElement | null = null;
function drawCollapseDanger(eng: Engine, octx: CanvasRenderingContext2D, w: number, h: number, vt: number, camX: number, camY: number) {
  const c = eng.finale.collapse;
  if (!c) return;
  // Two states, both masked to the DOOMED ground only (the calm is cut out), so
  // the red never washes the whole screen and can't be misread as taking a hit:
  //   telegraph — a restrained warning wash that builds and flickers as the
  //               eruption nears
  //   eruption  — a brief bright glare over exactly the ground that just fired
  const erupting = c.erupt > 0;
  let alpha: number;
  let base: string;
  if (erupting) {
    const ef = c.erupt / FINALE_ERUPT_DUR; // 1 → 0
    // a hard bright glare that snaps in and decays fast — impact you feel
    alpha = 0.84 * ef;
    base = ef > 0.7 ? 'rgb(255,60,86)' : 'rgb(214,22,46)';
  } else {
    const f = 1 - Math.max(0, c.t) / c.max;
    const flick = c.t < 0.6 ? 0.7 + 0.3 * Math.sin(vt * 26) : 1;
    // the doom builds hotter and floods the whole floor — there is no reading a
    // safe pocket out of it, so the warning is meant to feel inescapable
    const doomB = c.kind === 'doom' ? 1.15 : 1;
    alpha = (0.1 + 0.26 * f) * flick * doomB;
    base = c.kind === 'doom' ? 'rgb(150,6,30)' : 'rgb(122,4,26)';
  }
  const S = 4;
  const dw = Math.ceil(w / S), dh = Math.ceil(h / S);
  if (!_dangerC) _dangerC = document.createElement('canvas');
  if (_dangerC.width !== dw || _dangerC.height !== dh) { _dangerC.width = dw; _dangerC.height = dh; }
  const g = _dangerC.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, dw, dh);
  g.fillStyle = base;
  g.fillRect(0, 0, dw, dh);
  const toX = (x: number) => (x - camX) / S;
  const toY = (y: number) => (y - camY) / S;
  g.globalCompositeOperation = 'destination-out';
  if (c.kind === 'islands') {
    // Erase the whole calm solidly and feather only OUTWARD, past the true safe
    // radius, so no red bleeds inside the circle where the player stands.
    for (const isl of c.islands) {
      const r = isl.r / S;
      const feather = 22 / S;
      const cx = toX(isl.x), cy = toY(isl.y);
      const gr = g.createRadialGradient(cx, cy, Math.max(0, r - 3 / S), cx, cy, r + feather);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(cx, cy, r + feather, 0, Math.PI * 2); g.fill();
    }
  } else if (c.kind === 'band') {
    g.fillStyle = 'rgba(0,0,0,1)';
    g.beginPath();
    g.arc(toX(c.cx), toY(c.cy), c.r1 / S, 0, Math.PI * 2);
    g.arc(toX(c.cx), toY(c.cy), c.r0 / S, 0, Math.PI * 2, true);
    g.fill();
  } else if (c.kind === 'halves') {
    // halves: erase everything past the true safe boundary (local +y > 30)
    // solidly, feathering only back into the DOOMED side so the calm stays clear
    g.save();
    g.translate(toX(c.cx), toY(c.cy));
    g.rotate(c.halfA);
    const bound = 30 / S;
    const feather = 24 / S;
    const gr = g.createLinearGradient(0, bound - feather, 0, bound);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr;
    g.fillRect(-3000, bound - feather, 6000, feather);
    g.fillStyle = 'rgba(0,0,0,1)';
    g.fillRect(-3000, bound, 6000, 3000);
    g.restore();
  }
  octx.save();
  octx.globalAlpha = alpha;
  octx.drawImage(_dangerC, 0, 0, w, h);
  octx.restore();

  // one gold chevron from the dreamer toward the nearest calm, while unsafe
  // (never during the eruption itself — the moment to move has already passed)
  const p = eng.player;
  if (!erupting && c.kind !== 'doom' && !eng.finaleCollapseSafe(p.x, p.y + PLAYER_HURT_DY)) {
    let tx = p.x, ty = p.y;
    if (c.kind === 'islands') {
      let bd = Infinity;
      for (const isl of c.islands) {
        const d2 = (isl.x - p.x) ** 2 + (isl.y - p.y) ** 2;
        if (d2 < bd) { bd = d2; tx = isl.x; ty = isl.y; }
      }
    } else if (c.kind === 'band') {
      const a = Math.atan2(p.y - c.cy, p.x - c.cx);
      const mid = (c.r0 + c.r1) / 2;
      tx = c.cx + Math.cos(a) * mid;
      ty = c.cy + Math.sin(a) * mid;
    } else {
      const nx = -Math.sin(c.halfA), ny = Math.cos(c.halfA);
      const s = (p.x - c.cx) * nx + (p.y - c.cy) * ny;
      tx = p.x + nx * (150 - s);
      ty = p.y + ny * (150 - s);
    }
    const ang = Math.atan2(ty - p.y, tx - p.x);
    const pulse = 0.5 + 0.5 * Math.sin(vt * 9);
    const ax = p.x - camX + Math.cos(ang) * (74 + 14 * pulse);
    const ay = p.y - camY + Math.sin(ang) * (74 + 14 * pulse);
    octx.save();
    octx.translate(ax, ay);
    octx.rotate(ang);
    octx.scale(1 + 0.15 * pulse, 1 + 0.15 * pulse);
    octx.globalAlpha = 0.9;
    octx.fillStyle = '#ffd27a';
    octx.shadowColor = '#ffd27a';
    octx.shadowBlur = 18;
    octx.beginPath();
    octx.moveTo(18, 0);
    octx.lineTo(-9, -10);
    octx.lineTo(-4, 0);
    octx.lineTo(-9, 10);
    octx.closePath();
    octx.shadowBlur = 0;
    octx.lineJoin = 'round';
    octx.lineWidth = 4;
    octx.strokeStyle = 'rgba(6,4,16,0.85)';
    octx.stroke();
    octx.shadowBlur = 18;
    octx.fill();
    octx.restore();
  }
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
  // clock like positions, or growth/fade animations step visibly at 120Hz+.
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
      const lc = NEBULA_LOBES[i];
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
  } else if (z.kind === 'serpent') {
    // Dream Serpent: a weaving ribbon of deep water — overlapping translucent
    // segments trailing the head along the path it actually swam, so the body
    // bends through the serpent's turns rather than snapping to its heading
    const fade = Math.max(0, Math.min(1, lifeI * 2, (z.maxLife - lifeI) * 1.5));
    const g = z.grow;
    const ca = Math.cos(z.spin), sa = Math.sin(z.spin);
    const L = z.maxR * g; // body length — the arc the sim damages along
    const segs = 7;
    for (let i = segs - 1; i >= 0; i--) {
      const f = i / (segs - 1);
      // spine point at this arc-distance behind the head, and a slightly nearer
      // one to read the local tangent (so the wiggle rides the curve)
      serpentPoint(z, zx, zy, L * f, _serp);
      const bxp = _serp.x - camX, byp = _serp.y - camY;
      serpentPoint(z, zx, zy, Math.max(0, L * f - 10), _serp);
      let tx = (_serp.x - camX) - bxp, ty = (_serp.y - camY) - byp;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const wig = Math.sin(vt * 6 - f * 4.2 + z.seed) * (4 + 8 * f) * g;
      const sx2 = bxp - ty * wig; // offset along the local perpendicular (-ty,tx)
      const sy2 = byp + tx * wig;
      const r2 = zr * g * (1 - f * 0.55);
      sh.push(SHAPE_DISC, sx2, sy2, 0, r2, 0.72, 0.95, 0, 0.35, 0.84, 0.79, (0.42 - f * 0.22) * fade, 0.10, 0.28, 0.38);
    }
    // luminous head with a pale crest
    sh.push(SHAPE_DISC, x, y, 0, zr * g * 0.72, 0.6, 0.85, 0, 0.72, 1, 0.95, 0.5 * fade, 0.18, 0.45, 0.48);
    const glowSE = q.uv('glow')!;
    q.push(true, glowSE, x + ca * zr * g * 0.4, y + sa * zr * g * 0.4, 5 * g, 0, 0.9 * fade, 0.9, 1, 0.97, 1);
  } else if (z.kind === 'chimewave') {
    // Chime of Hours: a brass wavefront engraved with clock-dust. Ordinary
    // tolls sweep a wedge (z.ph = half-width, z.spin = its heading); the
    // crescendo (z.evolved, z.ph = 0) tolls the whole hour, full and brighter.
    const t = Math.max(0, lifeI / z.maxLife);
    sh.push(SHAPE_RING, x, y, z.spin, zr, 2.2, 9, z.ph, 1, 0.85, 0.63, t * (z.evolved ? 1 : 0.75), 0.40 * t, 0.28 * t, 0.10 * t);
    if (z.evolved) {
      sh.push(SHAPE_RING, x, y, 0, zr * 0.8, 1.6, 6, 0, 1, 0.95, 0.80, 0.6 * t, 0.30 * t, 0.24 * t, 0.10 * t);
      const starE2 = q.uv('p:star')!;
      for (let i = 0; i < 5; i++) {
        const a = z.seed + (i / 5) * TAU + vt * 0.6;
        q.push(true, starE2, x + Math.cos(a) * zr * 0.9, y + Math.sin(a) * zr * 0.9, 5 + 3 * t, a, t * 0.8, 1, 0.87, 0.6, 1);
      }
    }
  } else if (z.kind === 'prism') {
    // Kaleidoscope: a slowly turning glass triangle over a caustic pool
    const fade = Math.max(0, Math.min(1, lifeI * 2, (z.maxLife - lifeI) * 3));
    const bob = Math.sin(vt * 1.6 + z.seed) * 4;
    const py2 = y + bob;
    const R = 20;
    const sq = 0.55 + 0.45 * Math.abs(Math.sin(z.spin)); // fake 3D turn
    for (let k = 0; k < 3; k++) {
      const a0 = -Math.PI / 2 + (k / 3) * TAU;
      const a1 = -Math.PI / 2 + ((k + 1) / 3) * TAU;
      const x0 = x + Math.cos(a0) * R * sq, y0 = py2 + Math.sin(a0) * R;
      const x1 = x + Math.cos(a1) * R * sq, y1 = py2 + Math.sin(a1) * R;
      sh.push(SHAPE_CAPSULE, x0, y0, Math.atan2(y1 - y0, x1 - x0), Math.hypot(x1 - x0, y1 - y0), 1.6, 6, 0, 0.96, 0.79, 1, 0.85 * fade, 0.32, 0.42, 0.40);
    }
    const glowP = q.uv('glow')!;
    q.push(true, glowP, x, py2, 15, 0, 0.45 * fade, 0.96, 0.79, 1, 1);
    q.push(true, glowP, x, py2, 5, 0, 0.9 * fade, 1, 1, 1, 1);
    // caustic ring dancing on the ground beneath
    sh.push(SHAPE_RING, x, y + 34, 0, 17 + Math.sin(vt * 2.2 + z.seed) * 4, 1.2, 5, 0, 0.62, 1, 0.88, 0.22 * fade, 0.14, 0.28, 0.24);
  }
}

function emitBeam(sh: ShapeList, eng: Engine, b: Beam, alpha: number, camX: number, camY: number) {
  const t = Math.max(0, Math.min(1, (b.life + (1 - alpha) * STEP) / b.maxLife));
  const x = b.x - camX, y = b.y - camY;
  const a = lerp(b.pa, b.a, alpha);
  if (b.kind === 'gaze') {
    // the Sleepless Eye: a warm volumetric watch-light that fades in and out
    // over its whole sweep, crowned by the eye itself at the origin
    const f = Math.min(1, (1 - t) * 5, t * 3);
    sh.push(SHAPE_CAPSULE, x, y, a, b.len, b.w * 0.5, b.w * 0.55, 0, 1, 0.94, 0.72, 0.20 * f, 0.32, 0.25, 0.18);
    sh.push(SHAPE_CAPSULE, x, y, a, b.len, b.w * 0.14, b.w * 0.22, 0, 1, 0.97, 0.85, 0.42 * f, 0.40, 0.32, 0.22);
    // the eye: golden iris ring, hot pupil, a hint of pink sclera glow
    const blink = Math.min(1, f * 1.4);
    sh.push(SHAPE_RING, x, y - 34, eng.vt * 0.7, 13, 1.8, 6, 0, 1, 0.88, 0.55, blink, 0.42, 0.30, 0.14);
    sh.push(SHAPE_DISC, x, y - 34, 0, 5.5, 0.5, 1.2, 0, 1, 0.97, 0.85, 0.92 * blink, 0.45, 0.32, 0.20);
    sh.push(SHAPE_DISC, x, y - 34, 0, 20, 0.8, 1.6, 0, 1, 0.70, 0.95, 0.12 * blink, 0.25, 0.14, 0.22);
    return;
  }
  if (b.kind === 'ray') {
    // a Kaleidoscope refraction: hot white core with split RGB fringes
    sh.push(SHAPE_CAPSULE, x, y, a, b.len, 1.2, 5, 0, 1, 1, 1, 0.85 * t, 0.40, 0.36, 0.44);
    sh.push(SHAPE_CAPSULE, x, y, a + 0.01, b.len, 0.8, 3, 0, 1, 0.55, 0.75, 0.4 * t, 0.28, 0.08, 0.16);
    sh.push(SHAPE_CAPSULE, x, y, a - 0.01, b.len, 0.8, 3, 0, 0.55, 1, 0.85, 0.4 * t, 0.08, 0.28, 0.20);
    return;
  }
  const wNow = b.w * (0.4 + 0.6 * Math.sin(t * Math.PI));
  // radiant lance, two layers: a translucent body whose bright extent sits at
  // the collision half-width (w/2) so what you see is what hits, plus a thin
  // hot core. Alphas stay modest so enemies under several stacked lances
  // remain readable.
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
// Each translates an entity into instanced atlas quads. Rotation, bob and tint
// are per-instance params.

const FROZEN_TINT: [number, number, number] = [0.72, 0.89, 1];
// deterministic per-shard jitter for the Other Dreamer's glass-shatter death
const fhash = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
// nebula lobe hues (violet / pink / indigo)
const NEBULA_LOBES: [number, number, number][] = [[0.77, 0.55, 1], [1, 0.60, 0.84], [0.54, 0.48, 1]];

function emitEnemy(q: QuadList, shOver: ShapeList, eng: Engine, e: Enemy, alpha: number, camX: number, camY: number) {
  // The fallen are never drawn. Ordinarily a corpse is compacted out of the list
  // inside the same sim step, so this never came up — but the finale cinematic
  // owns the step and returns before the compaction runs, which left the Other
  // Dreamer standing whole (corona and all) right through his own shattering.
  if (e.dead) return;
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
  let bodyA = 1, bodyS = 1, bodyAsp = 1, bodyRot = 0;
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
  // soft ground shadow
  q.push(false, glowE, x, y + e.radius * 0.55, e.radius * 1.05 * bodyS, 0, 0.38 * bodyA, 0.01, 0.005, 0.03, 1, 0.34);

  // smooth hit-flash fade + freeze tint via per-instance shader mix
  const flashMix = e.hitFlash > 0 ? Math.min(1, e.hitFlash / 0.12) * 0.85 : 0;
  const frozen = e.slowT > 0 && flashMix === 0;
  const tr = frozen ? FROZEN_TINT[0] : 1, tg = frozen ? FROZEN_TINT[1] : 1, tb = frozen ? FROZEN_TINT[2] : 1;
  const mix = flashMix > 0 ? flashMix : frozen ? 0.55 : 0;

  const def = ENEMY_SPRITES[e.type];
  // bosses wear their archetype's own body (Devourer eye, Colossus golem,
  // Choir siren), scaled up from the base sprite by their radius
  const type = e.type;
  const sc = e.radius / ENEMY_TYPES[e.type].radius;
  const bob = def.bob(e.animT);
  let fi = ((e.animT * def.rate + e.seed) / TAU * def.frames) | 0;
  fi = ((fi % def.frames) + def.frames) % def.frames;
  const entry = q.uv(enemyFrameId(type, fi));
  if (!entry) return;
  const half = entry.half * sc;
  // eye tentacle crown: emitted UNDER the body as one live, continuously
  // rotating quad — smooth at any scale
  if (e.type === 'eye') {
    const tentE = q.uv('tentacles');
    if (tentE) {
      const hover = Math.sin(e.animT * 3 + e.seed) * 3 * sc;
      const spin = e.animT * 0.4 + e.seed;
      q.push(false, tentE, x, y + bob * sc + hover, tentE.half * sc, spin, 1, tr, tg, tb, mix);
      drawStats.enemyLiveOps++;
    }
  }
  // the Other Dreamer is alive on the smooth clock and never whites out under
  // fire — at this hour the player strikes so often a flash tint would leave him
  // permanently blanched. He sways and breathes, squares up to loose a volley,
  // and drinks a hit as a recoil rather than a bright flash.
  let bodyMix = mix;
  if (type === 'nightmare') {
    bodyMix = 0;
    const at = e.animT;
    bodyRot += Math.sin(at * 1.3) * 0.05;
    const breath = Math.sin(at * 2.2);
    bodyAsp *= 1 + breath * 0.05;
    bodyS *= 1 - breath * 0.02;
    const bf = e.bossFire;
    if (bf) {
      const charge = clamp(1 - bf.cd / 0.4, 0, 1);
      bodyS *= 1 + charge * 0.07;
      bodyRot *= 1 - charge * 0.75;
    }
    if (e.hitFlash > 0) bodyS *= 1 - Math.min(1, e.hitFlash / 0.12) * 0.035;
  }
  q.push(false, entry, x, y + bob * sc, half * bodyS, bodyRot, bodyA, tr, tg, tb, bodyMix, bodyAsp);
  drawStats.enemyBlits++;

  // ---- live overlays as extra quads (smooth, on the global clock) ----
  if (e.golden) {
    const ringE = q.uv('ring')!;
    // its dwindling time drives a quiet tell over the last few seconds: the halo
    // breathes a touch quicker and a single faint ring drifts inward, a soft
    // "it's slipping away" cue rather than an alarm (warn: 0 → 1)
    const warn = e.goldT > 0 && e.goldT < 3 ? 1 - e.goldT / 3 : 0;
    const gr = e.radius + 8 + Math.sin(vt * (4 + warn * 5)) * (2 + warn * 1.5);
    q.push(true, ringE, x, y, gr / 30 * ringE.half, 0, 0.8, 1, 0.82, 0.48, 1);
    if (warn > 0) {
      const phase = (vt * 0.9) % 1;
      const cr = e.radius + 3 + (1 - phase) * 18;
      q.push(true, ringE, x, y, cr / 30 * ringE.half, 0, warn * 0.2 * (0.4 + 0.6 * phase), 1, 0.78, 0.46, 1);
      const breathe = 0.5 + 0.5 * Math.sin(vt * 5);
      q.push(true, glowE, x, y, e.radius * 0.9, 0, 0.1 * warn * breathe, 1, 0.86, 0.5, 1);
    }
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
    // boss whatever body it took. As it enrages the corona quickens, swells and
    // bleeds toward angry red — a visible tell that its fire is ramping up.
    const ringE = q.uv('ring')!;
    let [br, bg, bb] = rgb(e.color);
    const rage = clamp((e.rageT - BOSS_RAGE_START) / BOSS_RAGE_FULL, 0, 1);
    const pulseSpd = 3 + rage * 7;
    const coronaR = e.radius + 16 + rage * 8 + Math.sin(vt * pulseSpd) * (4 + rage * 5);
    if (rage > 0) { br = lerp(br, 1, rage * 0.7); bg = lerp(bg, 0.18, rage * 0.6); bb = lerp(bb, 0.24, rage * 0.6); }
    q.push(true, ringE, x, y, coronaR / 30 * ringE.half, 0, (0.6 + rage * 0.35) * bodyA, br, bg, bb, 1);
    if (rage > 0.35) {
      // a second, hotter ring flares in as the fury peaks
      const r2 = e.radius + 26 + Math.sin(vt * pulseSpd + 1.5) * 6;
      q.push(true, ringE, x, y, r2 / 30 * ringE.half, 0, 0.4 * rage * bodyA, 1, 0.3, 0.32, 1);
    }
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
  // the Nightmare Brand: a red name written over the debtor. Everything scales
  // with the body so it reads just as loudly on a boss as on a wisp — a pulsing
  // target ring, a crosshair reaching past it, and a crooked rune above the head.
  if (e.nbT > 0) {
    const flick = 0.5 + 0.5 * Math.sin(vt * 9 + e.seed);
    const beat = 0.5 + 0.5 * Math.sin(vt * 4 + e.seed); // the debt's heartbeat
    const ringE = q.uv('ring')!;
    const runeE = q.uv('p:rune0')!;
    const rr = e.radius + 8 + beat * (4 + e.radius * 0.08);
    // the target ring + a second, wider pulse ring on the beat
    q.push(true, ringE, x, y, rr / 30 * ringE.half, 0, 0.75, 1, 0.30, 0.42, 1);
    q.push(true, ringE, x, y, (rr + 6 + beat * 8) / 30 * ringE.half, 0, 0.22 * beat, 1, 0.35, 0.48, 1);
    // crosshair marks reaching past the ring (scaled to the body)
    const tick = e.radius * 0.5 + 6;
    const cr = rr;
    const capE = q.uv('p:spark')!;
    for (let k = 0; k < 4; k++) {
      const a = k * (Math.PI / 2);
      q.push(true, capE, x + Math.cos(a) * (cr + tick * 0.5), y + Math.sin(a) * (cr + tick * 0.5), tick, a, 0.7, 1, 0.35, 0.48, 1, 0.3);
    }
    // the crooked rune hangs above the head, sized to the body
    const rs = 6 + e.radius * 0.12 + flick * 2;
    q.push(true, runeE, x, y - e.radius - rs - 4, rs, Math.sin(vt * 2 + e.seed) * 0.3, 0.55 + 0.4 * flick, 1, 0.35, 0.48, 1);
    q.push(true, glowE, x, y, e.radius * 0.9, 0, 0.06 + 0.08 * beat, 1, 0.30, 0.42, 1);
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
  // warlock: floating grimoire + orbiting charge-orbs, both on the smooth clock
  if (e.type === 'warlock') {
    const grimE = q.uv('grimoire');
    if (grimE) {
      const gph = vt * 1.6 + e.seed;
      const gx = x + 12 * sc;
      const gy = y + bob * sc + (-4 + Math.sin(gph) * 2) * sc;
      q.push(false, grimE, gx, gy, grimE.half * sc, -0.3 + Math.sin(gph) * 0.15, 1, tr, tg, tb, mix);
    }
    const orbE = q.uv('orb')!;
    const charge = e.ranged ? clamp(1 - e.shootCd / 1.2, 0, 1) : 0;
    // the charge-orb crown. On a boss the small additive orbs sat ON the huge
    // bright body and vanished into it — so the crown rises clear above the
    // head, gains two orbs, and each wears its own glow so it reads at scale.
    const nOrb = e.boss ? 5 : 3;
    const crownY = y + bob * sc - (e.boss ? 30 * sc + 8 : 22 * sc);
    const crownR = (e.boss ? 22 : 17) * sc;
    for (let i = 0; i < nOrb; i++) {
      const oa = vt * 2.4 + (i / nOrb) * TAU;
      const ox = x + Math.cos(oa) * crownR;
      const oy = crownY + Math.sin(oa) * 8 * sc;
      if (e.boss) q.push(true, glowE, ox, oy, 10 * sc, 0, 0.30, 1, 0.62, 0.95, 1);
      q.push(true, orbE, ox, oy, (5 + charge * 4) * sc, 0, (e.boss ? 0.9 : 0.65) + charge * 0.35);
    }
    drawStats.enemyLiveOps++;
  }
  // siren: charging mouth-glow + spark motes (baked frames are at rest)
  // (boss sirens never fire this volley — bossFire replaces it — so the
  // charge glow must not read their frozen shootCd)
  if (e.type === 'siren' && !e.boss && e.ranged && e.shootCd < 0.6) {
    const hover = Math.sin(e.animT * 4 + e.seed) * 3 * sc;
    const gy = y + bob * sc + hover - 4 * sc; // sits on the open singing mouth
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

  // the Other Dreamer: shards of his broken staff wheel around him, and the
  // wound in his chest breathes red on the smooth clock
  if (e.type === 'nightmare') {
    const shE = q.uv('shard')!;
    for (let i = 0; i < 5; i++) {
      const sa2 = vt * 1.4 + (i / 5) * TAU;
      const R2 = (34 + Math.sin(vt * 2.3 + i * 1.7) * 4) * sc;
      q.push(false, shE, x + Math.cos(sa2) * R2, y + bob * sc + Math.sin(sa2) * R2 * 0.55 - 10 * sc, shE.half * sc * 0.9, sa2, 0.9, 1, 0.13, 0.25, 0.9);
    }
    const beat = 0.5 + 0.5 * Math.sin(vt * 3.1);
    q.push(true, glowE, x, y + bob * sc - 4 * sc, (10 + beat * 5) * sc, 0, 0.5 + 0.3 * beat, 1, 0.13, 0.25, 1);
    // a struck note: the wound flares deeper red where a white flash would have
    // washed him out — the hit reads without blanching his whole form
    if (e.hitFlash > 0) {
      const hf = Math.min(1, e.hitFlash / 0.12);
      q.push(true, glowE, x, y + bob * sc - 4 * sc, e.radius * 0.95, 0, 0.3 * hf, 1, 0.13, 0.22, 1);
    }
    drawStats.enemyLiveOps++;
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
  let fi = ((p.animT * 8) / TAU * WIZARD_FRAMES) | 0;
  fi = ((fi % WIZARD_FRAMES) + WIZARD_FRAMES) % WIZARD_FRAMES;
  const wizE = q.uv(wizardFrameId(fi));
  if (!wizE) return;
  const mirrored = p.facing < 0;
  q.push(false, wizE, x, y - WIZARD_CY - bob, wizE.half, mirrored ? -sway : sway, alpha, 1, 1, 1, 0, 1, mirrored);
  // staff orb: pulsing beacon that flares on casts (castPulse)
  const skin = getWizardSkin();
  const [ogr, ogg, ogb] = rgb(skin.orbGlow);
  const [ocr, ocg, ocb] = rgb(skin.orbCore);
  const pulse = 5 + Math.sin(vt * 5) * 1.2 + p.castPulse * 6;
  const ox = x + 14 * p.facing;
  const oy = y - 48 - bob;
  q.push(true, glowE, ox, oy, pulse * 2.6, 0, 0.9 * alpha, ogr, ogg, ogb, 1);
  q.push(true, glowE, ox, oy, pulse * 1.05, 0, alpha, ocr, ocg, ocb, 1);
}

// Defensive spells drawn around the player. The Hush veil belongs under the
// swarm (a fog on the ground); the Somnal Ward's panes ride in front of it.
function emitDefenseUnder(sh: ShapeList, eng: Engine, x: number, y: number) {
  const p = eng.player;
  const vt = eng.vt;
  const hush = p.spells.find((s) => s.id === 'hush');
  if (!hush) return;
  const st = eng.spellStats('hush', hush.level, hush.mastery || 0);
  const R = st.radius! * eng.aoeMul();
  const breath = 0.5 + 0.5 * Math.sin(vt * 1.1);
  // a soft lilac fog pooled on the ground, a slow rune ring turning at its rim
  sh.push(SHAPE_DISC, x, y, 0, R, 0.55, 1.7, 0, 0.72, 0.65, 1, 0.045 + breath * 0.02, 0.30, 0.24, 0.55);
  sh.push(SHAPE_RING, x, y, vt * 0.25, R * 0.97, 1.3, 7, 0, 0.82, 0.72, 1, 0.10 + breath * 0.05, 0.28, 0.22, 0.5);
}

function emitDefenseOver(q: QuadList, eng: Engine, x: number, y: number) {
  const p = eng.player;
  if (!p.shieldMax || !p.spells.some((s) => s.id === 'ward')) return;
  const frac = clamp(p.shield / p.shieldMax, 0, 1);
  const mending = p.shieldT > 0; // the silent phase after a break
  const base = frac > 0 ? 0.15 + 0.85 * frac : (mending ? 0.05 : 0.12);
  const R = 34;
  const glowE = q.uv('glow')!;
  const shardE = q.uv('p:shard')!;
  const oy = y - 14;
  // a faint glass halo, brightening as the ward fills
  q.push(true, glowE, x, oy, R * 1.5, 0, 0.14 * base, 0.56, 0.72, 1, 1);
  const panes = 3;
  const a0 = p.shieldPh;
  for (let i = 0; i < panes; i++) {
    const a = a0 + (i / panes) * TAU;
    const px = x + Math.cos(a) * R;
    const py = oy + Math.sin(a) * R * 0.55; // squashed ring — a shallow orbit
    q.push(true, shardE, px, py, 11, a + Math.PI / 2, base * 0.9, 0.70, 0.82, 1, 1);
    q.push(true, glowE, px, py, 7, 0, base * 0.4, 0.90, 0.95, 1, 1);
  }
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

// Rimeheart: a dense orb of cold — a wide frozen aura wrapping a bright, faintly
// pulsing crystalline heart, with a crown of slow-turning ice facets.
function emitFrostOrbs(q: QuadList, eng: Engine, alpha: number, camX: number, camY: number) {
  if (!eng.frostOrbs.length) return;
  const glowE = q.uv('glow')!;
  const shardE = q.uv('shard')!;
  const s = eng.aoeMul(); // AoE fattens the ball, so the visual grows with the hitbox
  for (const o of eng.frostOrbs) {
    const x = lerp(o.px, o.x, alpha) - camX, y = lerp(o.py, o.y, alpha) - camY;
    const pulse = 0.85 + 0.15 * Math.sin(eng.vt * 3 + o.seed);
    q.push(true, glowE, x, y, 26 * pulse * s, 0, 0.34, 0.42, 0.86, 1, 1); // cold aura
    q.push(true, glowE, x, y, 13 * s, 0, 0.48, 0.58, 0.92, 1, 1);         // inner frost
    q.push(true, glowE, x, y, 6 * s, 0, 0.6, 0.72, 0.95, 1, 1);           // translucent cyan core (no white-out)
    // three ice facets orbiting the core, turning slowly
    for (let k = 0; k < 3; k++) {
      const fa = eng.vt * 1.1 + o.seed + (k / 3) * TAU;
      const fx = x + Math.cos(fa) * 11 * s, fy = y + Math.sin(fa) * 11 * s;
      q.push(false, shardE, fx, fy, 6.5 * s, fa + Math.PI / 2, 0.78, 0.56, 0.91, 1, 1);
    }
  }
}

// the Wisp Choir: teal spirit-flames trailing the player — kin to the Soul
// Lanterns and the Dream Serpent, not anonymous white dots. Each is a soft
// aura around a hot core with a flickering tail streaming behind its motion.
function emitWisps(q: QuadList, eng: Engine, alpha: number, camX: number, camY: number) {
  if (!eng.wisps.length) return;
  const glowE = q.uv('glow')!;
  const starE = q.uv('p:star')!;
  const sparkE = q.uv('p:spark')!;
  for (const w of eng.wisps) {
    const x = lerp(w.px, w.x, alpha) - camX, y = lerp(w.py, w.y, alpha) - camY;
    const tw = 0.5 + 0.5 * Math.sin(eng.vt * 4 + w.seed);
    // the tail streams opposite the motion; a hovering wisp lets it hang low
    const dx = w.x - w.px, dy = w.y - w.py;
    const moving = dx * dx + dy * dy > 0.25;
    const ta = moving ? Math.atan2(dy, dx) + Math.PI : Math.PI / 2 + Math.sin(eng.vt * 2.6 + w.seed) * 0.35;
    const tlen = 9 + tw * 4 + (moving ? 6 : 0);
    q.push(true, sparkE, x + Math.cos(ta) * tlen * 0.8, y + Math.sin(ta) * tlen * 0.8, tlen, ta, 0.4 + 0.2 * tw, 0.45, 1, 0.87, 1, 0.32);
    // aura → inner glow → white-hot heart
    q.push(true, glowE, x, y, 13 + tw * 4, 0, 0.55, 0.42, 1, 0.86, 1);
    q.push(true, glowE, x, y, 6, 0, 0.9, 0.66, 1, 0.93, 1);
    q.push(true, glowE, x, y, 3, 0, 1, 0.94, 1, 1, 1);
    q.push(true, starE, x, y - 2, 5 + tw * 2, eng.vt * 1.5 + w.seed, 0.5 + 0.4 * tw, 0.62, 1, 0.92, 1);
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
  } else if (pr.kind === 'iceshard') {
    // a slender crystal of cold, elongated along its flight
    const glowE = q.uv('glow')!;
    const shardE = q.uv('shard')!;
    const a = Math.atan2(pr.vy, pr.vx);
    q.push(true, glowE, x, y, 13, 0, 0.5, 0.56, 0.91, 1, 1);                     // icy halo
    q.push(false, shardE, x, y, 11, a + Math.PI / 2, 1, 0.56, 0.91, 1, 1, 1.9);  // elongated shard
    q.push(true, shardE, x, y, 11, a + Math.PI / 2, 0.4, 0.91, 0.98, 1, 1, 1.9); // bright core glint
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
  // velocity trail
  const sp = Math.hypot(bp.vx, bp.vy) || 1;
  const tl = Math.min(26, sp * 0.045) * s;
  // a Mirror Waltz reflection turns the entire shot petal-mint — trail, halo
  // and dart body — so friend/foe reads at a glance
  if (tl > 4) {
    if (bp.reflected) sh.push(SHAPE_CAPSULE, x - (bp.vx / sp) * tl, y - (bp.vy / sp) * tl, Math.atan2(bp.vy, bp.vx), tl, 1.4 * s, 4 * s, 0, 0.45, 1, 0.62, 0.5, 0.10, 0.40, 0.16);
    else sh.push(SHAPE_CAPSULE, x - (bp.vx / sp) * tl, y - (bp.vy / sp) * tl, Math.atan2(bp.vy, bp.vx), tl, 1.4 * s, 4 * s, 0, 1, 0.35, 0.39, 0.5, 0.4, 0.10, 0.11);
  }
  const glowE = q.uv('glow')!;
  const e = q.uv('proj:bullet')!;
  if (bp.reflected) {
    q.push(true, glowE, x, y, 22 * s * pulse, 0, 0.9, 0.49, 1, 0.69, 1);
    q.push(false, e, x, y, e.half * s, Math.atan2(bp.vy, bp.vx), 1, 0.5, 1, 0.66, 0.85);
  } else {
    q.push(true, glowE, x, y, 22 * s * pulse, 0, 0.9, 1, 0.4, 0.44, 1); // hot red halo
    q.push(false, e, x, y, e.half * s, Math.atan2(bp.vy, bp.vx), 1);
  }
}

// ---------------------------------------------------------------- particles
// Every particle mode maps to a real atlas sprite. Sparks stretch along their
// velocity; runes/stars/shards/petals spin; rings expand.
let _runeE: AtlasEntry[] | null = null;
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
  // atlas entries are stable for the whole session — cache the rune lookups
  // instead of building a fresh array every frame
  if (!_runeE) _runeE = [q.uv('p:rune0')!, q.uv('p:rune1')!, q.uv('p:rune2')!, q.uv('p:rune3')!];
  const runeE = _runeE;
  const cw = cam.w, ch = cam.h;
  // player-spell particles fade with the duel; the Dreamer's own (noDim) don't
  const sv = eng.spellVisibility;
  for (let i = 0; i < count; i++) {
    const pt = pool[i];
    const t = pt.life / pt.maxLife;
    const x = pt.x - camX, y = pt.y - camY;
    if (x < -80 || y < -80 || x > cw + 80 || y > ch + 80) continue;
    const size = pt.endSize + (pt.size - pt.endSize) * t;
    if (size < 1.2) continue;
    let a = t < 0.35 ? t / 0.35 : 1;
    if (a > 1) a = 1;
    if (!pt.noDim && sv < 1) a *= sv;
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
    if (e.type === 'nightmare') continue; // the Other Dreamer wears his own plate
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
