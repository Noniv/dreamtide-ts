// WebGPU scene renderer — the whole game world in one canvas, a handful of
// draw calls, entity-count-independent.
//
// Frame graph:
//   1. scene pass → HDR (rgba16float) offscreen target
//        a. background   : fullscreen procedural dreamscape (gradient sky,
//                          domain-warped nebula, aurora veils, 3 parallax
//                          star layers, drifting colour motes) — zero CPU cost
//        b. shapes       : instanced analytic SDF primitives (rings, discs,
//                          spirals, capsules) for spell zones, beams and
//                          lightning — crisp at any radius, glow baked into
//                          the math instead of Canvas2D stroke tricks
//        c. sprites      : every entity/particle as one instanced quad from
//                          the baked atlas. ONE draw in exact painter's order:
//                          premultiplied-alpha output where additive quads
//                          write alpha 0, so "lighter" and "source-over"
//                          blending coexist in a single pipeline.
//   2. bloom             : threshold prefilter → 4-mip downsample → additive
//                          tent upsample chain (CoD-style). Everything bright
//                          — glows, beams, star cores — blooms for free.
//   3. composite → swapchain: scene + bloom, filmic-ish soft tonemap,
//                          vignette, dither.
//
// Instances are packed into two big Float32Arrays refilled every frame by
// render.ts; total per-frame GPU traffic is a couple of writeBuffer calls.
// WebGPU is REQUIRED — there is no fallback renderer.

import { getAtlas, type Atlas, type AtlasEntry } from './enemySprites';
import { hdrSupported } from './settings';

export const FLOATS_PER_QUAD = 16;
const MAX_QUADS = 16384; // entities + particles ceiling, with headroom
export const FLOATS_PER_SHAPE = 16;
const MAX_SHAPES = 2048; // zones/beams/bolt-segments ceiling

// shape kinds (match the WGSL switch)
export const SHAPE_RING = 0;
export const SHAPE_DISC = 1;
export const SHAPE_SPIRAL = 2;
export const SHAPE_CAPSULE = 3;

// ---- one growable instance list the emitters fill each frame --------------
export class QuadList {
  atlas: Atlas;
  data = new Float32Array(MAX_QUADS * FLOATS_PER_QUAD);
  n = 0;
  // multiplies the alpha of every quad pushed while set — lets a whole layer
  // (e.g. the player's spells during the boss duel) fade as one, without
  // threading a factor through every emitter. Always restored to 1.
  groupAlpha = 1;

  constructor() { this.atlas = getAtlas(); }

  reset() { this.n = 0; this.groupAlpha = 1; }

  // look up a sprite's atlas entry (uv + half)
  uv(id: string): AtlasEntry | undefined { return this.atlas.entries.get(id); }

  // push one quad, drawn in push order (painter's algorithm).
  //   additive : true → light-emitting (blends like Canvas2D 'lighter')
  //   aspect   : halfY = half * aspect (squashed shadows, stretched sparks)
  //   mirror   : flip horizontally (UV swap) — used for the wizard's facing
  push(
    additive: boolean,
    e: AtlasEntry,
    x: number, y: number, half: number, rot: number,
    alpha: number,
    tintR = 1, tintG = 1, tintB = 1, tintMix = 0,
    aspect = 1, mirror = false,
  ) {
    if (this.n >= MAX_QUADS) return;
    const o = this.n * FLOATS_PER_QUAD;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = half; d[o + 3] = rot;
    if (mirror) { d[o + 4] = e.u1; d[o + 6] = e.u0; } else { d[o + 4] = e.u0; d[o + 6] = e.u1; }
    d[o + 5] = e.v0; d[o + 7] = e.v1;
    d[o + 8] = tintR; d[o + 9] = tintG; d[o + 10] = tintB; d[o + 11] = tintMix;
    d[o + 12] = alpha * this.groupAlpha; d[o + 13] = aspect; d[o + 14] = additive ? 1 : 0; d[o + 15] = 0;
    this.n++;
  }
}

// Analytic shape instances (zones, beams, bolts). Same painter's-order rule.
// Layout: [x, y, rot, kind, p0, p1, p2, p3, c1.rgb, alpha, c2.rgb, additive]
//   RING    p0=radius  p1=core width  p2=glow width  p3=arc half-gap (rad, 0=full)
//   DISC    p0=radius  p1=colour mid  p2=falloff exp p3=unused
//   SPIRAL  p0=radius  p1=arm count   p2=coil (rad)  p3=arm width px
//   CAPSULE p0=length  p1=core width  p2=glow width  p3=unused  (+x from origin)
// c1 = core colour, alpha = master alpha, c2 = glow colour (pre-scaled by the
// emitter for glow strength — the HDR target happily takes >1 values).
export class ShapeList {
  data = new Float32Array(MAX_SHAPES * FLOATS_PER_SHAPE);
  n = 0;
  groupAlpha = 1;
  reset() { this.n = 0; this.groupAlpha = 1; }
  push(
    kind: number, x: number, y: number, rot: number,
    p0: number, p1: number, p2: number, p3: number,
    c1r: number, c1g: number, c1b: number, alpha: number,
    c2r: number, c2g: number, c2b: number, additive = true,
  ) {
    if (this.n >= MAX_SHAPES) return;
    const o = this.n * FLOATS_PER_SHAPE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = rot; d[o + 3] = kind;
    d[o + 4] = p0; d[o + 5] = p1; d[o + 6] = p2; d[o + 7] = p3;
    d[o + 8] = c1r; d[o + 9] = c1g; d[o + 10] = c1b; d[o + 11] = alpha * this.groupAlpha;
    d[o + 12] = c2r; d[o + 13] = c2g; d[o + 14] = c2b; d[o + 15] = additive ? 1 : 0;
    this.n++;
  }
}

// ============================================================ WGSL: scene
const SCENE_WGSL = /* wgsl */ `
struct U {
  viewport: vec2<f32>,   // logical (css px) size of the view
  time: f32,
  viewScale: f32,        // world→screen zoom (innerHeight / DESIGN_H)
  cam: vec2<f32>,        // world position of the view's top-left (world units)
  res: vec2<f32>,        // framebuffer pixel size of the scene target
  pad0: f32,             // (hdr flag in the post-process U — unused here)
  corrupt: f32,          // 0..1 — the Other Dreamer holds the dream (finale corruption)
  mood: f32,             // run stages: each +1 ≈ 5 min deeper, ever more psychedelic → horror
  pad1: f32,             // (alignment)
  player: vec2<f32>,     // dreamer world position — the corruption eye tracks it
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

// ---------------------------------------------------------------- helpers
fn hash21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn hash22(p: vec2<f32>) -> vec2<f32> {
  let h = vec2(hash21(p), hash21(p + 17.17));
  return h;
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2(1.0, 0.0));
  let c = hash21(i + vec2(0.0, 1.0));
  let d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
fn fbm(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var amp = 0.55;
  var q = p;
  for (var i = 0; i < 4; i++) {
    v += vnoise(q) * amp;
    q = q * 2.13 + vec2(11.7, 5.3);
    amp *= 0.5;
  }
  return v;
}
// rotate a colour about the grey axis — a true hue rotation (Rodrigues' formula)
fn hueRotate(c: vec3<f32>, a: f32) -> vec3<f32> {
  let k = vec3<f32>(0.57735027);   // normalized (1,1,1)
  let ca = cos(a);
  let sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

// ------------------------------------------------------------- background
struct BGOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn bg_vs(@builtin(vertex_index) vi: u32) -> BGOut {
  var out: BGOut;
  let xy = vec2(f32((vi << 1u) & 2u), f32(vi & 2u));
  out.pos = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2(xy.x, 1.0 - xy.y);
  return out;
}

// one parallax star field layer: hashed grid, round soft stars, twinkle
fn starLayer(px: vec2<f32>, par: f32, cell: f32, bright: f32, t: f32) -> f32 {
  let wp = px + u.cam * par;
  let g = wp / cell;
  let id = floor(g);
  let h = hash22(id);
  let starPos = (id + 0.15 + h * 0.7) * cell;
  let d = length(wp - starPos);
  let sz = 0.6 + hash21(id + 3.3) * 1.6;
  let tw = 0.4 + 0.6 * (0.5 + 0.5 * sin(t * (1.0 + h.x * 2.4) + h.y * 40.0));
  // keep a subset of cells starless so the grid never reads as a grid
  let keep = step(0.35, hash21(id + 9.1));
  return exp(-d * d / (sz * sz)) * tw * bright * keep;
}

@fragment
fn bg_fs(in: BGOut) -> @location(0) vec4<f32> {
  var px = in.uv * u.viewport / u.viewScale; // world-unit screen coords (matches u.cam)
  let t = u.time;

  // ------------- the corruption: the Other Dreamer holds the dream ---------
  // Not a colour grade but a different sky: the field tears in horizontal
  // shears, everything painterly swims on a breathing warp, blood-veins crack
  // through the clouds, a vast slit-pupiled eye hangs over the dream, and the
  // palette drains to bone and blood. All driven by u.corrupt (0 → 1).
  let cor = clamp(u.corrupt, 0.0, 1.0);
  if (cor > 0.001) {
    // horizontal tearing: whole bands of the sky skip sideways for a frame
    let band = floor(in.uv.y * 36.0);
    let seed = vec2(band, floor(t * 9.0));
    let tear = step(0.94, hash21(seed)) * (hash21(seed + 7.0) - 0.5);
    px.x += tear * 260.0 * cor;
    // the breathing warp: the sky is a membrane, and something pushes on it
    let breathe = sin(t * 2.1 + in.uv.y * 5.0) * sin(t * 0.63);
    px += vec2(sin(px.y * 0.006 + t * 0.9), cos(px.x * 0.005 - t * 0.7)) * 30.0 * cor * (0.5 + 0.5 * breathe);
  }

  // how far the dream has strayed from waking as it runs long and deep:
  //   psy    — psychedelic swell of the deep dream (colour cycling, churning warp)
  //   horror — dread that only creeps in once a dream runs long and deep
  let mood = u.mood;
  let psy = clamp(mood, 0.0, 3.0);
  let horror = smoothstep(1.2, 3.0, mood);
  // the slow hue-swim of everything painterly in the sky
  let hueA = mood * 0.7 + sin(t * 0.05) * psy * 0.6;

  // deep dream sky: vertical gradient, slightly denser at the horizon line.
  // The deeper the dream runs, the more bruised the sky beneath it grows.
  let y = in.uv.y;
  var col = mix(vec3(0.030, 0.026, 0.105), vec3(0.078, 0.052, 0.180), y);
  col = mix(col, vec3(0.105, 0.060, 0.230), y * y * 0.8);
  col = mix(col, vec3(0.045, 0.010, 0.030), horror * 0.5);
  // corruption: the sky itself goes near-black, lit only by what bleeds through
  col = mix(col, vec3(0.014, 0.002, 0.006), cor * 0.85);

  // domain-warped nebula clouds, slow parallax drift (world-locked). The warp
  // churns harder as the dream turns psychedelic.
  let warpAmp = 1.7 + psy * 0.6;
  let np = (px + u.cam * 0.22) * 0.0016;
  let warp = vec2(fbm(np * 0.9 + vec2(t * 0.014, 0.0)), fbm(np * 0.9 + vec2(4.7, t * 0.011)));
  let neb = fbm(np + warp * warpAmp);
  let neb2 = fbm(np * 1.9 - warp * 1.2 + vec2(8.2, 1.3));
  // two-tone dream nebula: violet body, magenta-teal highlights, colour-cycling
  // the deeper the dream goes
  let nebI = smoothstep(0.42, 0.95, neb);
  let nebJ = smoothstep(0.55, 1.0, neb2);
  var nebCol = vec3(0.16, 0.09, 0.34) * nebI * 0.55;
  nebCol += vec3(0.30, 0.10, 0.28) * nebJ * nebI * 0.5;
  nebCol += vec3(0.05, 0.16, 0.22) * smoothstep(0.6, 1.0, fbm(np * 2.6 + warp)) * 0.35;
  col += hueRotate(nebCol, hueA + neb * psy * 0.4);
  // horror: something red bleeds up through the clouds, pulsing like a wound
  col += vec3(0.42, 0.03, 0.08) * horror * pow(nebI, 1.5) * (0.35 + 0.4 * sin(t * 1.6 + neb * 7.0));

  // corruption: blood-veins crack through the whole field, beating in time
  if (cor > 0.001) {
    let vp = (px + u.cam * 0.3) * 0.004;
    let vn = fbm(vp + vec2(t * 0.03, -t * 0.02));
    let vein = pow(1.0 - abs(vn * 2.0 - 1.0), 9.0);
    let veinPulse = 0.55 + 0.45 * sin(t * 2.3 + vn * 12.0);
    col += vec3(0.55, 0.02, 0.07) * vein * veinPulse * cor;
    let vn2 = fbm(vp * 2.7 + vec2(3.1, t * 0.05));
    col += vec3(0.30, 0.01, 0.05) * pow(1.0 - abs(vn2 * 2.0 - 1.0), 12.0) * cor * 0.7;
  }

  // aurora veils: two soft diagonal light bands sweeping very slowly
  let ap = px + u.cam * 0.3;
  let a1 = 0.5 + 0.5 * sin(ap.x * 0.0021 + ap.y * 0.0009 + t * 0.10 + warp.x * 2.6);
  let a2 = 0.5 + 0.5 * sin(ap.x * -0.0014 + ap.y * 0.0016 - t * 0.07 + warp.y * 3.1);
  col += hueRotate(vec3(0.10, 0.30, 0.26), hueA) * pow(a1, 4.0) * 0.10;
  col += hueRotate(vec3(0.24, 0.12, 0.34), hueA) * pow(a2, 4.0) * 0.11;

  // three parallax star layers (near layer brightest, bloom catches the cores)
  col += vec3(0.36, 0.42, 0.71) * starLayer(px, 0.12, 110.0, 0.55, t);
  col += vec3(0.56, 0.63, 0.91) * starLayer(px + vec2(37.0, 71.0), 0.22, 130.0, 0.8, t);
  col += vec3(0.80, 0.85, 1.00) * starLayer(px + vec2(113.0, 29.0), 0.35, 170.0, 1.25, t);

  // drifting colour motes: sparse, larger, softly pulsing dream dust, hue-cycling
  // with the mood
  {
    let par = 0.55;
    let cell = 210.0;
    var wp = px + u.cam * par;
    wp.y += t * 9.0;                       // slow upward drift (world falls past)
    let id = floor(wp / cell);
    let h = hash22(id);
    var mp = (id + 0.2 + h * 0.6) * cell;
    mp.x += sin(t * 0.3 + h.y * 6.28) * 26.0;
    let d = length(wp - mp);
    let r = 2.2 + h.x * 3.4;
    let pulse = 0.55 + 0.45 * sin(t * (0.6 + h.y) + h.x * 6.28);
    // pick one of four dream hues per cell
    let hs = hash21(id + 5.5);
    var hue = vec3(0.71, 0.55, 1.00);                       // violet
    if (hs < 0.25) { hue = vec3(0.50, 0.96, 1.00); }        // cyan
    else if (hs < 0.5) { hue = vec3(1.00, 0.60, 0.84); }    // pink
    else if (hs < 0.75) { hue = vec3(0.49, 1.00, 0.69); }   // mint
    hue = hueRotate(hue, hueA * 0.6);
    col += hue * exp(-d * d / (r * r * 9.0)) * 0.22 * pulse * step(0.45, hash21(id + 2.2));
  }

  // the deep dream breathes — a slow throb of the whole field as horror sets in
  col *= 1.0 + horror * 0.10 * sin(t * 1.7);

  // ------------- corruption, the heavy hand ---------------------------------
  if (cor > 0.001) {
    // the eye of the Other Dreamer: a vast blood eye that hangs over the
    // dream, WATCHING — its pupil tracks the dreamer, it darts to new corners
    // of the sky every few seconds, and it blinks. Everything about it is live.
    let sp = in.uv * u.viewport / u.viewScale;
    let vps = u.viewport / u.viewScale;
    // relocation: hold at a hashed corner, then dart to the next each period
    let period = 7.0;
    let seg = floor(t / period);
    let fseg = fract(t / period);
    let hA = hash22(vec2(seg, 7.3));
    let hB = hash22(vec2(seg + 1.0, 7.3));
    let dart = smoothstep(0.74, 0.9, fseg);          // quick snap late in each hold
    let anchor = mix(hA, hB, dart);
    // keep it in the upper two-thirds, using the whole width
    let mc = (vec2(0.1, 0.08) + anchor * vec2(0.8, 0.5)) * vps
             + vec2(sin(t * 0.7) * 6.0, cos(t * 0.9) * 5.0); // live micro-tremor
    let mR = min(vps.x, vps.y) * 0.17;
    // blink: the lid sweeps closed briefly (~every 9s), squashing the eye flat
    let bt = fract(t * 0.11);
    let open = 1.0 - smoothstep(0.0, 0.045, bt) * smoothstep(0.11, 0.045, bt) * 0.94;
    let ed = sp - mc;
    let md = length(vec2(ed.x, ed.y / max(0.08, open))); // vertical squash for the blink
    let disc = smoothstep(mR, mR * 0.9, md);
    let mot = fbm((sp - mc) * 0.012 + vec2(t * 0.02, 0.0));
    var eye = vec3(0.30, 0.012, 0.045) * (0.55 + 0.45 * mot);
    // iris veins converging on the pupil
    let ea = atan2(ed.y, ed.x);
    eye += vec3(0.34, 0.02, 0.05) * pow(0.5 + 0.5 * sin(ea * 22.0 + mot * 8.0), 6.0) * smoothstep(mR * 0.15, mR * 0.7, md);
    // the pupil LOOKS at the dreamer: a slit that slides toward the player and
    // orients to face them (long axis perpendicular to the look direction)
    let pEye = u.player - u.cam;                       // dreamer in screen-world coords
    let look = normalize(pEye - mc + vec2(0.0001, 0.0001));
    let perp = vec2(-look.y, look.x);
    let pc = mc + look * mR * 0.44;                    // pupil offset toward the player
    let rel = sp - pc;
    let along = dot(rel, look);                        // across the thin slit
    let across = dot(rel, perp);                       // along the tall slit
    let focus = 0.75 + 0.25 * sin(t * 0.5);            // the slit dilates and narrows
    let slitW = mR * 0.15 * focus;
    let pupil = smoothstep(slitW, slitW * 0.35, abs(along))
              * smoothstep(mR * 0.9, mR * 0.62, abs(across)) * disc;
    // a hot catch-light at the pupil's leading edge, toward the player
    let glint = exp(-length(sp - (pc - look * mR * 0.1)) / (mR * 0.06)) * disc;
    eye = mix(eye, vec3(0.004, 0.0, 0.002), pupil);
    eye += vec3(0.6, 0.3, 0.34) * glint * 0.5;
    col = mix(col, eye, disc * cor * 0.92);
    col += vec3(0.40, 0.02, 0.06) * exp(-max(md - mR, 0.0) * 0.008) * (1.0 - disc) * 0.4 * cor * (0.7 + 0.3 * sin(t * 1.3));

    // drain every other colour: bone and blood only
    let lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum) * vec3(1.55, 0.22, 0.30), cor * 0.55);
    // strobing unease: an irregular double-pulse breathing of the whole field
    let beat = sin(t * 2.4) * 0.5 + sin(t * 4.8 + 1.2) * 0.28;
    col *= 1.0 - cor * (0.14 + 0.14 * beat);
    // the dark clawing inward from the edges
    let vuv = in.uv - 0.5;
    col *= 1.0 - cor * smoothstep(0.16, 0.6, dot(vuv, vuv)) * 0.55;
  }

  return vec4(col, 1.0);
}

// ------------------------------------------------------------------ quads
struct QuadVSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) tint: vec4<f32>,          // rgb + mix
  @location(2) alphaAdd: vec2<f32>,      // alpha, additive
};

@vertex
fn quad_vs(
  @builtin(vertex_index) vi: u32,
  @location(0) iPos: vec2<f32>,
  @location(1) iHalfRot: vec2<f32>,      // half, rot
  @location(2) iUV: vec4<f32>,           // u0 v0 u1 v1 (u0>u1 → mirrored)
  @location(3) iTint: vec4<f32>,         // r g b mix
  @location(4) iMisc: vec4<f32>,         // alpha, aspect, additive, pad
) -> QuadVSOut {
  var corners = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0),
  );
  let corner = corners[vi];
  let half = iHalfRot.x;
  let rot = iHalfRot.y;
  let c = cos(rot); let s = sin(rot);
  let local = vec2(corner.x * half, corner.y * half * iMisc.y);
  let rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  let px = (iPos + rotated) * u.viewScale;
  let clip = vec2(px.x / u.viewport.x * 2.0 - 1.0, 1.0 - px.y / u.viewport.y * 2.0);
  var out: QuadVSOut;
  out.pos = vec4(clip, 0.0, 1.0);
  let uv01 = (corner + 1.0) * 0.5;
  out.uv = mix(iUV.xy, iUV.zw, uv01);
  out.tint = iTint;
  out.alphaAdd = vec2(iMisc.x, iMisc.z);
  return out;
}

@fragment
fn quad_fs(in: QuadVSOut) -> @location(0) vec4<f32> {
  let texel = textureSample(tex, samp, in.uv);
  // tintMix replaces rgb (keeps sprite alpha) — hit flash, freeze, particles
  let rgb = mix(texel.rgb, in.tint.rgb, in.tint.a);
  let a = texel.a * in.alphaAdd.x;
  // premultiplied output; additive instances contribute no coverage
  return vec4(rgb * a, a * (1.0 - in.alphaAdd.y));
}

// ----------------------------------------------------------------- shapes
struct ShapeVSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,          // shape-frame coords (px)
  @location(1) @interpolate(flat) kind: u32,
  @location(2) p: vec4<f32>,
  @location(3) c1: vec4<f32>,
  @location(4) c2: vec4<f32>,             // rgb + additive
};

@vertex
fn shape_vs(
  @builtin(vertex_index) vi: u32,
  @location(0) iPosRotKind: vec4<f32>,
  @location(1) iP: vec4<f32>,
  @location(2) iC1: vec4<f32>,
  @location(3) iC2: vec4<f32>,
) -> ShapeVSOut {
  var corners = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0),
  );
  let t01 = corners[vi];
  let kind = u32(iPosRotKind.w);
  // shape-frame bounding box
  var lo = vec2(0.0);
  var hi = vec2(0.0);
  // glow margin: the fragment windows the exponential falloff to reach zero
  // exactly here — quads any tighter clip the glow into a visible square
  if (kind == 3u) { // capsule: from origin along +x
    let m = iP.y + iP.z * 4.0 + 3.0;
    lo = vec2(-m, -m);
    hi = vec2(iP.x + m, m);
  } else {
    var ext = iP.x;
    if (kind == 0u) { ext = iP.x + iP.y + iP.z * 4.0 + 3.0; }
    lo = vec2(-ext);
    hi = vec2(ext);
  }
  let local = mix(lo, hi, t01);
  let rot = iPosRotKind.z;
  let c = cos(rot); let s = sin(rot);
  let world = (iPosRotKind.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c)) * u.viewScale;
  let clip = vec2(world.x / u.viewport.x * 2.0 - 1.0, 1.0 - world.y / u.viewport.y * 2.0);
  var out: ShapeVSOut;
  out.pos = vec4(clip, 0.0, 1.0);
  out.local = local;
  out.kind = kind;
  out.p = iP;
  out.c1 = iC1;
  out.c2 = iC2;
  return out;
}

@fragment
fn shape_fs(in: ShapeVSOut) -> @location(0) vec4<f32> {
  let l = in.local;
  let p = in.p;
  var core = 0.0;
  var glow = 0.0;
  switch in.kind {
    case 0u: { // RING
      let d = abs(length(l) - p.x);
      core = 1.0 - smoothstep(0.0, max(p.y, 0.5), d);
      // windowed exponential: exp() alone never reaches 0, so it would clip
      // at the instance quad's edge as a faint square — the window (matching
      // the vertex margin) takes it smoothly to zero first
      let M = p.y + p.z * 4.0 + 3.0;
      let win = 1.0 - smoothstep(0.0, M, d);
      glow = exp(-d / max(p.z, 0.5)) * win * win;
      if (p.w > 0.0) { // arc: visible only within ±p3 radians of local +x
        let ang = abs(atan2(l.y, l.x));
        let mask = 1.0 - smoothstep(p.w - 0.2, p.w + 0.2, ang);
        core *= mask;
        glow *= mask;
      }
    }
    case 1u: { // DISC: two-stop soft radial fill
      let f = clamp(length(l) / max(p.x, 0.5), 0.0, 1.0);
      let s = pow(1.0 - f, max(p.z, 0.35));
      core = s * (1.0 - smoothstep(0.0, max(p.y, 0.001), f));
      glow = s * smoothstep(0.0, max(p.y, 0.001), f);
    }
    case 2u: { // SPIRAL arms
      let d = length(l);
      let f = d / max(p.x, 1.0);
      if (f < 1.0 && f > 0.02) {
        let ang = atan2(l.y, l.x);
        let armsOverTau = p.y / 6.2831853;
        let g = (ang - f * p.z) * armsOverTau;
        let angDist = abs(fract(g) - 0.5) / max(armsOverTau, 0.001); // radians
        let arc = angDist * d;                                       // px
        let fade = smoothstep(1.0, 0.72, f) * smoothstep(0.02, 0.14, f);
        core = exp(-arc * arc / (p.w * p.w)) * fade;
        glow = exp(-arc / (p.w * 2.4)) * fade;
      }
    }
    case 3u: { // CAPSULE (beam / bolt segment)
      let q = vec2(clamp(l.x, 0.0, p.x), 0.0);
      let d = length(l - q);
      core = 1.0 - smoothstep(0.0, max(p.y, 0.5), d);
      let M = p.y + p.z * 4.0 + 3.0; // same windowing as RING (no square edge)
      let win = 1.0 - smoothstep(0.0, M, d);
      glow = exp(-d / max(p.z, 0.5)) * win * win;
    }
    default: {}
  }
  let a = clamp(core, 0.0, 1.0) * in.c1.a;
  let rgb = (in.c1.rgb * core + in.c2.rgb * glow) * in.c1.a;
  return vec4(rgb, a * (1.0 - in.c2.a)); // c2.a holds the additive flag
}
`;

// ============================================================ WGSL: post
const POST_WGSL = /* wgsl */ `
struct U {
  viewport: vec2<f32>,
  time: f32,
  shake: f32,
  cam: vec2<f32>,
  res: vec2<f32>,
  hdr: f32,              // >0.5 → present in HDR (extended-range highlights)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct FSIn { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn fs_vs(@builtin(vertex_index) vi: u32) -> FSIn {
  var out: FSIn;
  let xy = vec2(f32((vi << 1u) & 2u), f32(vi & 2u));
  out.pos = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2(xy.x, 1.0 - xy.y);
  return out;
}

// soft-knee bright-pass + first downsample
@fragment
fn prefilter_fs(in: FSIn) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSampleLevel(src, samp, in.uv + vec2(-0.5, -0.5) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(0.5, -0.5) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(-0.5, 0.5) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(0.5, 0.5) * ts, 0.0).rgb;
  c *= 0.25;
  let T = 1.0;       // threshold — only genuinely hot (stacked/HDR) pixels bloom
  let K = 0.5;       // soft knee
  let br = max(c.r, max(c.g, c.b));
  let soft = clamp(br - T + K, 0.0, 2.0 * K);
  let w = max(soft * soft / (4.0 * K), br - T) / max(br, 1e-4);
  return vec4(c * max(w, 0.0), 1.0);
}

@fragment
fn down_fs(in: FSIn) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSampleLevel(src, samp, in.uv + vec2(-0.75, -0.75) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(0.75, -0.75) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(-0.75, 0.75) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(0.75, 0.75) * ts, 0.0).rgb;
  return vec4(c * 0.25, 1.0);
}

// 9-tap tent upsample, additively blended into the target mip
@fragment
fn up_fs(in: FSIn) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSampleLevel(src, samp, in.uv + vec2(-1.0, -1.0) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(0.0, -1.0) * ts, 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2(1.0, -1.0) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(-1.0, 0.0) * ts, 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, samp, in.uv + vec2(1.0, 0.0) * ts, 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2(-1.0, 1.0) * ts, 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2(0.0, 1.0) * ts, 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2(1.0, 1.0) * ts, 0.0).rgb;
  return vec4(c / 16.0, 1.0);
}

fn hash12(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2(443.897, 441.423));
  q += dot(q, q.yx + 19.19);
  return fract((q.x + q.y) * q.x);
}

@fragment
fn composite_fs(in: FSIn) -> @location(0) vec4<f32> {
  var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb;
  c += bloom * 0.62;
  if (u.hdr > 0.5) {
    // HDR present: 1.0 is SDR white and brighter pixels drive into the display's
    // headroom instead of compressing to white. Cap the headroom (~+2.6 stops)
    // so stacked additive bursts stay a highlight, not a floodlight.
    c = min(c, vec3<f32>(6.0));
  } else {
    // Shoulder-only tonemap: IDENTITY below the knee so sprites keep their full
    // contrast against the dark sky; only the overbright range (stacked additive
    // effects, HDR values past ~0.72 luma) is compressed toward white.
    let luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    let e = max(luma - 0.72, 0.0);
    let lumaC = min(luma, 0.72) + e / (1.0 + e * 3.0);
    c *= lumaC / max(luma, 1e-4);
  }
  // vignette
  let dc = (in.uv - 0.5) * vec2(u.viewport.x / u.viewport.y, 1.0) * 1.35;
  let vig = 1.0 - smoothstep(0.52, 1.15, length(dc)) * 0.52;
  c *= vig;
  // dither to hide 8-bit banding in the dark sky gradients
  c += (hash12(in.uv * u.res + u.time * 61.7) - 0.5) * (1.6 / 255.0);
  return vec4(max(c, vec3(0.0)), 1.0);
}
`;

export interface WorldGPU {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  /** Human-readable adapter identity ("nvidia · rtx 3060 …") for perf logs. */
  readonly adapterLabel: string;
  resize(cssW: number, cssH: number, dpr: number, viewScale?: number): void;
  render(time: number, camX: number, camY: number, shapes: ShapeList, quads: QuadList, over?: ShapeList, corrupt?: number, mood?: number, playerX?: number, playerY?: number): void;
  /** Switch HDR presentation on/off. Silently stays SDR if the display can't
   *  do HDR right now. Returns whether HDR is actually active afterwards. */
  setHDR(enabled: boolean): boolean;
  dispose(): void;
}

const BLOOM_MIPS = 4;

class WorldGPUImpl implements WorldGPU {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly adapterLabel: string;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private hdrActive = false;
  private postModule!: GPUShaderModule;
  private postPL!: GPUPipelineLayout;

  private pipeBG!: GPURenderPipeline;
  private pipeShape!: GPURenderPipeline;
  private pipeShapeOver!: GPURenderPipeline;
  private pipeQuad!: GPURenderPipeline;
  private pipePrefilter!: GPURenderPipeline;
  private pipeDown!: GPURenderPipeline;
  private pipeUp!: GPURenderPipeline;
  private pipeComposite!: GPURenderPipeline;

  private sceneLayout!: GPUBindGroupLayout;
  private postLayout!: GPUBindGroupLayout;
  private uniBuf: GPUBuffer;
  private uniData = new Float32Array(16);
  private sampler: GPUSampler;
  private atlas: Atlas;
  private atlasTex: GPUTexture;
  private atlasVersion: number;
  private sceneBind!: GPUBindGroup;

  private quadBuf: GPUBuffer;
  private shapeBuf: GPUBuffer;
  private shapeOverBuf: GPUBuffer;

  // offscreen targets (rebuilt on resize)
  private sceneTex: GPUTexture | null = null;
  private bloomTex: (GPUTexture | null)[] = [];
  private bloomViews: GPUTextureView[] = [];
  private sceneView!: GPUTextureView;
  private prefilterBind!: GPUBindGroup;
  private downBinds: GPUBindGroup[] = [];
  private upBinds: GPUBindGroup[] = [];
  private compositeBind!: GPUBindGroup;

  private cssW = 1; private cssH = 1;
  private texW = 1; private texH = 1;
  private viewScale = 1;

  // Reused render-pass descriptors (the view/loadOp fields are re-pointed each
  // pass). beginRenderPass copies what it needs, so mutating between passes is
  // safe — and it spares ~10 descriptor object trees per frame.
  private sceneAttach: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
  };
  private sceneDesc: GPURenderPassDescriptor = { colorAttachments: [this.sceneAttach] };
  private postAttach: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 },
  };
  private postDesc: GPURenderPassDescriptor = { colorAttachments: [this.postAttach] };

  constructor(canvas: HTMLCanvasElement, device: GPUDevice, atlas: Atlas, adapterLabel: string) {
    this.canvas = canvas;
    this.device = device;
    this.adapterLabel = adapterLabel;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('could not create a WebGPU canvas context');
    this.ctx = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.configureCanvas();

    // atlas texture
    this.atlas = atlas;
    this.atlasVersion = atlas.version;
    this.atlasTex = device.createTexture({
      size: [atlas.size, atlas.size],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.uploadAtlas();
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.uniBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.quadBuf = device.createBuffer({ size: MAX_QUADS * FLOATS_PER_QUAD * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.shapeBuf = device.createBuffer({ size: MAX_SHAPES * FLOATS_PER_SHAPE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.shapeOverBuf = device.createBuffer({ size: MAX_SHAPES * FLOATS_PER_SHAPE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

    this.buildPipelines();
  }

  // (Re)copy the atlas canvas into the GPU texture. Called once up front and
  // again whenever the atlas canvas is repainted in place (skin swaps bump
  // atlas.version; tile rects never change, so the texture size is stable).
  private uploadAtlas() {
    this.device.queue.copyExternalImageToTexture(
      { source: this.atlas.canvas },
      { texture: this.atlasTex, premultipliedAlpha: false },
      [this.atlas.size, this.atlas.size],
    );
    this.atlasVersion = this.atlas.version;
  }

  private buildPipelines() {
    const device = this.device;
    const sceneModule = device.createShaderModule({ code: SCENE_WGSL });
    const postModule = device.createShaderModule({ code: POST_WGSL });

    this.sceneLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.postLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const scenePL = device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] });
    const postPL = device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
    this.postModule = postModule;
    this.postPL = postPL;

    // premultiplied "over" blending: additive instances emit alpha 0, so a
    // single pipeline serves both source-over and lighter composition
    const premult: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const HDR: GPUTextureFormat = 'rgba16float';

    this.pipeBG = device.createRenderPipeline({
      layout: scenePL,
      vertex: { module: sceneModule, entryPoint: 'bg_vs' },
      fragment: { module: sceneModule, entryPoint: 'bg_fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list' },
    });

    const quadAttrs: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },
      { shaderLocation: 1, offset: 8, format: 'float32x2' },
      { shaderLocation: 2, offset: 16, format: 'float32x4' },
      { shaderLocation: 3, offset: 32, format: 'float32x4' },
      { shaderLocation: 4, offset: 48, format: 'float32x4' },
    ];
    this.pipeQuad = device.createRenderPipeline({
      layout: scenePL,
      vertex: {
        module: sceneModule, entryPoint: 'quad_vs',
        buffers: [{ arrayStride: FLOATS_PER_QUAD * 4, stepMode: 'instance', attributes: quadAttrs }],
      },
      fragment: { module: sceneModule, entryPoint: 'quad_fs', targets: [{ format: HDR, blend: premult }] },
      primitive: { topology: 'triangle-list' },
    });

    const shapeAttrs: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' },
      { shaderLocation: 3, offset: 48, format: 'float32x4' },
    ];
    // Shapes SCREEN-blend (src·(1−dst) + dst·(1−srcα)) instead of summing:
    // overlapping same-kind zones (drifting nebulas, stacked pools) saturate
    // toward one continuous cloud rather than doubling up — the bright
    // lens-shaped seam where two AoE circles cross disappears. Additive
    // instances (α=0) become pure screen; alpha instances keep their darkening
    // term. Sprites stay on plain premultiplied blending — enemy body colours
    // must not shift with what's behind them.
    const screen: GPUBlendState = {
      color: { srcFactor: 'one-minus-dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const mkShapePipe = (blend: GPUBlendState) => device.createRenderPipeline({
      layout: scenePL,
      vertex: {
        module: sceneModule, entryPoint: 'shape_vs',
        buffers: [{ arrayStride: FLOATS_PER_SHAPE * 4, stepMode: 'instance', attributes: shapeAttrs }],
      },
      fragment: { module: sceneModule, entryPoint: 'shape_fs', targets: [{ format: HDR, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipeShape = mkShapePipe(screen);
    // the over pass (melee slashes) draws AFTER sprites where the HDR buffer
    // can exceed 1 — screen's (1−dst) factor would go negative and etch dark
    // arcs into hot areas, so it keeps plain premultiplied blending
    this.pipeShapeOver = mkShapePipe(premult);

    const mkPost = (entry: string, format: GPUTextureFormat, blend?: GPUBlendState) => device.createRenderPipeline({
      layout: postPL,
      vertex: { module: postModule, entryPoint: 'fs_vs' },
      fragment: { module: postModule, entryPoint: entry, targets: [{ format, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipePrefilter = mkPost('prefilter_fs', HDR);
    this.pipeDown = mkPost('down_fs', HDR);
    this.pipeUp = mkPost('up_fs', HDR, {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    });
    this.buildComposite();

    this.sceneBind = device.createBindGroup({
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniBuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.atlasTex.createView() },
      ],
    });
  }

  // (re)configure the swapchain for the current SDR/HDR mode. HDR uses an
  // rgba16float canvas with extended tone mapping so highlights can exceed SDR
  // white; SDR uses the preferred 8-bit format.
  private configureCanvas() {
    this.format = this.hdrActive ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
    const config: GPUCanvasConfiguration = { device: this.device, format: this.format, alphaMode: 'opaque' };
    // toneMapping is newer than these @webgpu/types; attach it untyped.
    if (this.hdrActive) (config as { toneMapping?: { mode: string } }).toneMapping = { mode: 'extended' };
    this.ctx.configure(config);
  }

  // Composite is the only pipeline whose target is the swapchain, so its format
  // tracks SDR↔HDR and it is rebuilt whenever the mode changes.
  private buildComposite() {
    this.pipeComposite = this.device.createRenderPipeline({
      layout: this.postPL,
      vertex: { module: this.postModule, entryPoint: 'fs_vs' },
      fragment: { module: this.postModule, entryPoint: 'composite_fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  setHDR(enabled: boolean): boolean {
    const active = enabled && hdrSupported();
    if (active === this.hdrActive) return this.hdrActive;
    this.hdrActive = active;
    try {
      this.configureCanvas();
      this.buildComposite();
    } catch (e) {
      console.warn('[dreamtide] HDR presentation unavailable, staying SDR:', e);
      this.hdrActive = false;
      this.configureCanvas();
      this.buildComposite();
    }
    return this.hdrActive;
  }

  resize(cssW: number, cssH: number, dpr: number, viewScale = 1) {
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.cssW = cssW; this.cssH = cssH;
    this.viewScale = viewScale;
    if (this.canvas.width === w && this.canvas.height === h && this.sceneTex) return;
    this.canvas.width = w; this.canvas.height = h;
    this.texW = w; this.texH = h;

    // (re)create offscreen targets
    const device = this.device;
    this.sceneTex?.destroy();
    for (const t of this.bloomTex) t?.destroy();
    this.bloomTex = [];
    this.bloomViews = [];
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.sceneTex = device.createTexture({ size: [w, h], format: 'rgba16float', usage });
    this.sceneView = this.sceneTex.createView();
    let mw = w, mh = h;
    for (let i = 0; i < BLOOM_MIPS; i++) {
      mw = Math.max(4, mw >> 1); mh = Math.max(4, mh >> 1);
      const t = device.createTexture({ size: [mw, mh], format: 'rgba16float', usage });
      this.bloomTex.push(t);
      this.bloomViews.push(t.createView());
    }

    // post bind groups (dummy secondary texture where unused)
    const mkBind = (srcView: GPUTextureView, extraView?: GPUTextureView) => device.createBindGroup({
      layout: this.postLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniBuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: srcView },
        { binding: 3, resource: extraView || srcView },
      ],
    });
    this.prefilterBind = mkBind(this.sceneView);
    this.downBinds = [];
    this.upBinds = [];
    for (let i = 1; i < BLOOM_MIPS; i++) this.downBinds.push(mkBind(this.bloomViews[i - 1]));
    for (let i = BLOOM_MIPS - 1; i >= 1; i--) this.upBinds.push(mkBind(this.bloomViews[i]));
    this.compositeBind = mkBind(this.sceneView, this.bloomViews[0]);
  }

  render(time: number, camX: number, camY: number, shapes: ShapeList, quads: QuadList, over?: ShapeList, corrupt = 0, mood = 0, playerX = 0, playerY = 0) {
    if (!this.sceneTex) return;
    if (this.atlas.version !== this.atlasVersion) this.uploadAtlas();
    const device = this.device;
    const u = this.uniData;
    u[0] = this.cssW; u[1] = this.cssH;
    u[2] = time; u[3] = this.viewScale;
    u[4] = camX; u[5] = camY;
    u[6] = this.texW; u[7] = this.texH;
    u[8] = this.hdrActive ? 1 : 0;   // hdr flag for the post pass; pad0 for the scene pass
    u[9] = corrupt; u[10] = mood;
    u[12] = playerX; u[13] = playerY; // player world pos (struct offset 48)
    device.queue.writeBuffer(this.uniBuf, 0, u);
    if (quads.n > 0) device.queue.writeBuffer(this.quadBuf, 0, quads.data, 0, quads.n * FLOATS_PER_QUAD);
    if (shapes.n > 0) device.queue.writeBuffer(this.shapeBuf, 0, shapes.data, 0, shapes.n * FLOATS_PER_SHAPE);
    if (over && over.n > 0) device.queue.writeBuffer(this.shapeOverBuf, 0, over.data, 0, over.n * FLOATS_PER_SHAPE);

    const enc = device.createCommandEncoder();

    // ---- scene: background + shapes + sprites into the HDR target ----
    {
      this.sceneAttach.view = this.sceneView;
      const pass = enc.beginRenderPass(this.sceneDesc);
      pass.setBindGroup(0, this.sceneBind);
      pass.setPipeline(this.pipeBG);
      pass.draw(3);
      if (shapes.n > 0) {
        pass.setPipeline(this.pipeShape);
        pass.setVertexBuffer(0, this.shapeBuf);
        pass.draw(6, shapes.n);
      }
      if (quads.n > 0) {
        pass.setPipeline(this.pipeQuad);
        pass.setVertexBuffer(0, this.quadBuf);
        pass.draw(6, quads.n);
      }
      if (over && over.n > 0) { // combat feedback drawn above the sprites
        pass.setPipeline(this.pipeShapeOver);
        pass.setVertexBuffer(0, this.shapeOverBuf);
        pass.draw(6, over.n);
      }
      pass.end();
    }

    // ---- bloom: prefilter → downsample chain → additive tent upsample ----
    const fullscreen = (pipe: GPURenderPipeline, bind: GPUBindGroup, view: GPUTextureView, load: GPULoadOp) => {
      this.postAttach.view = view;
      this.postAttach.loadOp = load;
      const pass = enc.beginRenderPass(this.postDesc);
      pass.setBindGroup(0, bind);
      pass.setPipeline(pipe);
      pass.draw(3);
      pass.end();
    };
    fullscreen(this.pipePrefilter, this.prefilterBind, this.bloomViews[0], 'clear');
    for (let i = 1; i < BLOOM_MIPS; i++) fullscreen(this.pipeDown, this.downBinds[i - 1], this.bloomViews[i], 'clear');
    for (let k = 0, i = BLOOM_MIPS - 1; i >= 1; i--, k++) fullscreen(this.pipeUp, this.upBinds[k], this.bloomViews[i - 1], 'load');

    // ---- composite to the swapchain ----
    fullscreen(this.pipeComposite, this.compositeBind, this.ctx.getCurrentTexture().createView(), 'clear');

    device.queue.submit([enc.finish()]);
  }

  dispose() {
    this.quadBuf.destroy();
    this.shapeBuf.destroy();
    this.shapeOverBuf.destroy();
    this.uniBuf.destroy();
    this.sceneTex?.destroy();
    for (const t of this.bloomTex) t?.destroy();
    this.atlasTex.destroy();
  }
}

// Create the scene renderer on the given canvas. WebGPU is mandatory: rejects
// with a descriptive error if unavailable (the engine surfaces it to the UI).
export async function createWorldGPU(canvas: HTMLCanvasElement): Promise<WorldGPU> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is not available in this environment');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter found');
  const device = await adapter.requestDevice();
  return new WorldGPUImpl(canvas, device, getAtlas(), describeAdapter(adapter));
}

// Identify which physical GPU the browser actually handed us. On hybrid
// (iGPU + dGPU) machines the powerPreference above is only a hint — Windows
// per-app graphics settings can override it — and a run that silently lands
// on the integrated GPU looks exactly like "the game is slow". The perf
// overlay exports this string so tester logs settle the question.
function describeAdapter(adapter: GPUAdapter): string {
  let info: Partial<GPUAdapterInfo> | undefined;
  try {
    info = adapter.info; // Chrome 128+ / current spec
  } catch { /* older implementations */ }
  const parts = [info?.vendor, info?.architecture, info?.description || info?.device]
    .filter((s): s is string => !!s && s.length > 0);
  const label = parts.length ? parts.join(' · ') : 'adapter info unavailable';
  // a fallback adapter is CPU/software rendering (SwiftShader) — flag it loudly
  // (the flag lives on GPUAdapterInfo in the current spec, on GPUAdapter in older ones)
  const fallback = info?.isFallbackAdapter ?? (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  return fallback ? `${label} [SOFTWARE FALLBACK]` : label;
}
