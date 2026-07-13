// Procedural sprite atlas. Every sprite the WebGPU world renderer draws is
// painted once with Canvas2D vector code at supersampled resolution and packed
// into a single texture: enemy animation frames, the wizard, gems, projectile
// bodies, particle shapes, pickups and utility glows.
//
// WHAT IS BAKED vs LIVE
//   baked  : the internal shape morph driven by animT (wing flap, flame lick,
//            robe hem ripple). Discretised into each sprite's own `frames`
//            steps of a canonical loop; per-enemy `seed` selects a frame so
//            enemies never march in lockstep.
//   live   : bob/hover, rotation, hit-flash / freeze tint (per-instance shader
//            tint — no baked variants), coronas, the eye's player-tracking
//            iris. Applied per-instance at emit time so the motions the eye
//            actually locks onto stay continuous.

const SS = 3;                      // supersample factor (bake at 3x for crisp magnification)
const PAD = 10;                    // px padding around the art (glow spill)

// Parametric body painters: draw the type's shape at loop phase `ph` in [0,1),
// in local space centred at (0,0). Hit-flash / frozen tints are applied by the
// renderer per-instance (shader colour mix), so painters bake natural colours.
type Painter = (ctx: CanvasRenderingContext2D, ph: number) => void;

const TAU = Math.PI * 2;

// Everything the atlas and the renderer need to know about one enemy body:
//   half   : art half-extent in local (pre-scale) space, generous enough to
//            contain glows/coronas/tentacles. Bosses reuse the sheet scaled up.
//   frames : baked loop samples. 1 = static body (motion lives in live-quad
//            parts instead). Soft additive morphs hide stepping well (8–12);
//            hard-edged large motion wants 24, as does any body a boss wears
//            magnified.
//   rate   : animT → baked-loop phase frequency (the sin() frequency of the
//            body's morph, e.g. bat flap = animT*14).
//   bob    : live per-instance vertical hover, applied at emit time so it
//            stays continuous at any scale.
export interface EnemySpriteDef {
  half: number;
  frames: number;
  rate: number;
  bob: (animT: number) => number;
  paint: Painter;
}

const NO_BOB = () => 0;

export const ENEMY_SPRITES: Record<string, EnemySpriteDef> = {
  wisp: { half: 26, frames: 12, rate: 9, bob: NO_BOB, paint(ctx, ph) {
    const a = ph * TAU;
    const f = Math.sin(a);          // flame lick, one full cycle across the sheet
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = radial(ctx, 20, '#dffcff', '#7ff5ff');
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(190,250,255,0.85)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 6 - 3, 2);
      ctx.quadraticCurveTo(i * 7 + f * 3, -14 - Math.abs(i) * -4, i * 6 + f * 4, -20 - f * 3 + Math.abs(i) * 6);
      ctx.quadraticCurveTo(i * 8 + 3, -8, i * 6 + 3, 2);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#eafeff';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0b2a3a';
    const blink = Math.sin(a * 1.3) > 0.92 ? 0.2 : 1;
    ctx.beginPath();
    ctx.ellipse(-3.2, -1, 1.4, 2.4 * blink, 0, 0, TAU);
    ctx.ellipse(3.2, -1, 1.4, 2.4 * blink, 0, 0, TAU);
    ctx.fill();
  } },

  bat: { half: 30, frames: 24, rate: 14, bob: (t) => Math.sin(t * 5) * 2, paint(ctx, ph) {
    const a = ph * TAU;
    const flap = Math.sin(a);       // one wingbeat across the sheet
    // (hover bob is applied LIVE by the caller, not baked)
    ctx.fillStyle = '#5b3a9e';
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
      ctx.strokeStyle = '#7a55c9';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(5, 0); ctx.lineTo(24, -5);
      ctx.moveTo(5, 2); ctx.lineTo(15, 6);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = '#7a55c9';
    ctx.beginPath(); ctx.ellipse(0, 0, 7.5, 9.5, 0, 0, TAU); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-5, -7); ctx.lineTo(-6.5, -14); ctx.lineTo(-1.5, -9);
    ctx.moveTo(5, -7); ctx.lineTo(6.5, -14); ctx.lineTo(1.5, -9);
    ctx.closePath(); ctx.fill();
    // eyes: baked soft glow dot + hot core (bloom pass amplifies these)
    softGlow(ctx, -2.8, -2, 6, 'rgba(255,90,122,0.75)');
    softGlow(ctx, 2.8, -2, 6, 'rgba(255,90,122,0.75)');
    ctx.fillStyle = '#ff5a7a';
    ctx.beginPath(); ctx.arc(-2.8, -2, 1.5, 0, TAU); ctx.arc(2.8, -2, 1.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-2, 4); ctx.lineTo(-1, 7); ctx.lineTo(0, 4);
    ctx.moveTo(2, 4); ctx.lineTo(1, 7); ctx.lineTo(0, 4);
    ctx.fill();
  } },

  // eye: bake the eyeball WITHOUT the iris (iris tracks the player → drawn live
  // as a tiny quad by the caller). The tentacle crown is a separate static
  // sprite emitted as one live continuously-rotating quad — smooth at any
  // scale, which matters for the magnified boss. Body is static → one frame.
  eye: { half: 34, frames: 1, rate: 1, bob: (t) => Math.sin(t * 3) * 3, paint(ctx, _ph) {
    ctx.fillStyle = '#fdeef6';
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill();
    // veins (static)
    ctx.strokeStyle = 'rgba(200,80,120,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-13, -4); ctx.quadraticCurveTo(-8, -2, -7, 2);
    ctx.moveTo(12, 5); ctx.quadraticCurveTo(8, 3, 7, -1);
    ctx.stroke();
  } },

  shade: { half: 30, frames: 24, rate: 5, bob: NO_BOB, paint(ctx, ph) {
    const wave = ph * TAU;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(60,40,120,0.35)';
    ctx.beginPath(); ctx.ellipse(-Math.sin(wave) * 4, 12, 12, 5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = linGrad(ctx, 0, -22, 0, 16, '#4a3a96', '#1c1440');
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
  } },

  golem: { half: 34, frames: 24, rate: 2, bob: NO_BOB, paint(ctx, ph) {
    const a = ph * TAU;
    const breathe = Math.sin(a) * 1.5;
    // orbiting rock chunks are emitted as LIVE quads by the caller (a full
    // orbit baked over 24 frames read as choppy); body only is baked here.
    ctx.fillStyle = linGrad(ctx, 0, -20, 0, 16, '#7fb7d9', '#2a4a72');
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
  } },

  // siren: a spectral pale chorister — a veiled, gowned wraith singing, hollow
  // mournful eyes and an open mouth where the charging glow (drawn live by the
  // caller) blooms. The gown hem and side veils sway; the rest is baked at rest.
  siren: { half: 24, frames: 24, rate: 4, bob: (t) => Math.sin(t * 4) * 3, paint(ctx, ph) {
    const a = ph * TAU;
    const sway = Math.sin(a);
    // trailing veils streaming to either side
    ctx.fillStyle = 'rgba(125,201,255,0.32)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 5, -4);
      ctx.quadraticCurveTo(side * 17, 3 + sway * side * 3, side * 11, 18);
      ctx.quadraticCurveTo(side * 7, 8, side * 2, 8);
      ctx.closePath(); ctx.fill();
    }
    // gown: a tall spectral bell, pale at the crown, deepening below, hem waving
    ctx.fillStyle = linGrad(ctx, 0, -18, 0, 20, '#eaf6ff', '#4f86c0');
    ctx.beginPath();
    ctx.moveTo(0, -20);
    ctx.quadraticCurveTo(10, -13, 9, -2);
    for (let i = 0; i <= 6; i++) {
      const fr = i / 6;
      ctx.lineTo(9 - fr * 18, 12 + Math.sin(a + fr * 6.5) * 2.4 + fr * 4);
    }
    ctx.quadraticCurveTo(-10, -13, 0, -20);
    ctx.fill();
    // a translucent veil framing the face
    ctx.fillStyle = 'rgba(184,222,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.quadraticCurveTo(11, -18, 8, -6);
    ctx.quadraticCurveTo(0, -9, -8, -6);
    ctx.quadraticCurveTo(-11, -18, 0, -22);
    ctx.fill();
    // luminous face
    ctx.fillStyle = '#f2fbff';
    ctx.beginPath(); ctx.ellipse(0, -12, 5.4, 6.6, 0, 0, TAU); ctx.fill();
    // hollow, mournful eyes: soft cyan glow around dark vertical cores
    softGlow(ctx, -2.4, -13, 5, 'rgba(120,200,255,0.8)');
    softGlow(ctx, 2.4, -13, 5, 'rgba(120,200,255,0.8)');
    ctx.fillStyle = '#0b2530';
    ctx.beginPath();
    ctx.ellipse(-2.4, -13, 1.2, 2.3, 0, 0, TAU);
    ctx.ellipse(2.4, -13, 1.2, 2.3, 0, 0, TAU);
    ctx.fill();
    // open singing mouth — a dark oval that widens with the song, faint inner light
    softGlow(ctx, 0, -4, 3.4, 'rgba(150,220,255,0.45)');
    ctx.fillStyle = '#08202e';
    ctx.beginPath(); ctx.ellipse(0, -4, 1.9, 2.8 + Math.abs(sway) * 1.1, 0, 0, TAU); ctx.fill();
    // a faint choir-halo above the crown
    ctx.strokeStyle = 'rgba(205,240,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, -22, 6, 2.1, 0, 0, TAU); ctx.stroke();
  } },

  // the Other Dreamer's true form: a towering anti-magus — near-black tattered
  // robe over a cracked porcelain mask with three burning eyes, the dreamer's
  // own bent hat torn open, a thorn-crown clawing up behind. Only worn by the
  // fifteenth-minute boss; weight 0 keeps it out of the wave tables.
  nightmare: { half: 44, frames: 24, rate: 4, bob: (t) => Math.sin(t * 2.2) * 3, paint(ctx, ph) {
    const a = ph * TAU;
    const writhe = Math.sin(a);
    // thorn-crown clawing up from behind the shoulders
    ctx.strokeStyle = '#2a0f1c';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 6, -20);
      ctx.quadraticCurveTo(s * 16, -30 + writhe * s, s * 18, -38);
      ctx.moveTo(s * 13, -31); ctx.lineTo(s * 19, -33);
      ctx.moveTo(s * 16, -35); ctx.lineTo(s * 21, -40);
      ctx.stroke();
    }
    // darkness pooled where it stands
    ctx.fillStyle = 'rgba(20,8,20,0.5)';
    ctx.beginPath(); ctx.ellipse(writhe * 2, 26, 20, 6, 0, 0, TAU); ctx.fill();
    // the robe: a bell of starless night, hem torn and writhing
    ctx.fillStyle = linGrad(ctx, 0, -26, 0, 28, '#241028', '#07030c');
    ctx.beginPath();
    ctx.moveTo(0, -30);
    ctx.quadraticCurveTo(19, -18, 17, 4);
    for (let i = 0; i <= 8; i++) {
      const fr = i / 8;
      ctx.lineTo(17 - fr * 34, 22 + Math.sin(a + fr * 11) * 4 - fr * 3 + (i % 2) * 4);
    }
    ctx.quadraticCurveTo(-19, -18, 0, -30);
    ctx.fill();
    // glimpses of the crimson lining
    ctx.fillStyle = 'rgba(120,10,35,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.quadraticCurveTo(12, -14, 10, 6);
    ctx.quadraticCurveTo(2, 12, -3, 8);
    ctx.quadraticCurveTo(-8, -8, 0, -26);
    ctx.fill();
    // the wound in the chest, cracked open on red light
    softGlow(ctx, 0, -4, 10, 'rgba(255,45,80,0.75)');
    ctx.strokeStyle = '#ff3d5e';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-4, -8); ctx.lineTo(0, -3); ctx.lineTo(-2, 2);
    ctx.moveTo(0, -3); ctx.lineTo(4, -1);
    ctx.stroke();
    // the dreamer's own hat, wrong: bent cone torn open at the tip
    const bend = Math.sin(a * 0.5) * 2;
    ctx.fillStyle = '#0d0714';
    ctx.beginPath(); ctx.ellipse(0.5, -34, 15, 4, -0.08, 0, TAU); ctx.fill();
    ctx.fillStyle = linGrad(ctx, 0, -36, 0, -60, '#140a1d', '#2a1031');
    ctx.beginPath();
    ctx.moveTo(-8, -36);
    ctx.quadraticCurveTo(-4, -50, 3 + bend, -54);
    ctx.lineTo(6 + bend, -50);
    ctx.lineTo(10 + bend, -58);
    ctx.quadraticCurveTo(9, -46, 9, -36.5);
    ctx.closePath();
    ctx.fill();
    // cracked porcelain mask
    ctx.fillStyle = '#ded6e8';
    ctx.beginPath();
    ctx.moveTo(-7, -31);
    ctx.quadraticCurveTo(-9, -22, -4, -16);
    ctx.quadraticCurveTo(0, -13.5, 4, -16);
    ctx.quadraticCurveTo(9, -22, 7, -31);
    ctx.quadraticCurveTo(0, -34, -7, -31);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,15,35,0.8)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-3, -31); ctx.lineTo(-4.5, -25); ctx.lineTo(-2.5, -21);
    ctx.moveTo(5, -28); ctx.lineTo(3, -23);
    ctx.stroke();
    // three red eyes — no mouth
    const sq = 1 + Math.sin(a * 1.3) * 0.25;
    softGlow(ctx, -3, -25, 5.5, 'rgba(255,32,64,0.85)');
    softGlow(ctx, 3, -25, 5.5, 'rgba(255,32,64,0.85)');
    softGlow(ctx, 0, -29.5, 4, 'rgba(255,32,64,0.7)');
    ctx.fillStyle = '#ff2040';
    ctx.beginPath();
    ctx.ellipse(-3, -25, 1.7, 2.4 * sq, 0.15, 0, TAU);
    ctx.ellipse(3, -25, 1.7, 2.4 * sq, -0.15, 0, TAU);
    ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -29.5, 1.1, 1.7 * sq, 0, 0, TAU); ctx.fill();
    // ashen claws parting the sleeves
    ctx.strokeStyle = '#8f93a8';
    ctx.lineWidth = 1.6;
    for (const s of [-1, 1]) {
      const rx = s * 15, ry = -6 + writhe * s * 1.5;
      ctx.beginPath();
      for (let f = -1; f <= 1; f++) {
        ctx.moveTo(rx, ry);
        ctx.quadraticCurveTo(rx + s * 4, ry + 3 + f * 2.4, rx + s * 7, ry + 5 + f * 3.4);
      }
      ctx.stroke();
    }
  } },

  warlock: { half: 26, frames: 1, rate: 3, bob: (t) => Math.sin(t * 3) * 2, paint(ctx, _ph) {
    ctx.fillStyle = linGrad(ctx, 0, -20, 0, 16, '#7a3aa8', '#2a1040');
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
    // the floating grimoire + orbiting charge-orbs are emitted as LIVE quads by
    // the caller: a hard-edged book baked into 24 frames read as choppy at boss
    // scale (unlike the soft glows other bosses hide their stepping behind), so
    // the body sheet is fully static (frames: 1) and the book rides the smooth
    // clock.
  } },
};

export const ENEMY_KINDS = Object.keys(ENEMY_SPRITES);

// ------------------------------------------------------------------- wizard
// The player joins the GPU world as a baked sprite sheet: robe hem ripple and
// hat bend are the loop; bob, sway (quad rotation), facing (UV mirror), blink
// (quad alpha) and the staff orb (live glow quads) are applied per-instance.
// Local space: baked centred at the wizard's mid-point, which sits WIZARD_CY
// px above the feet anchor the engine simulates.
export const WIZARD_CY = 25;   // sprite centre sits this far above the feet
export const WIZARD_HALF = 38;
export const WIZARD_FRAMES = 24;

// A skin is a full palette for the wizard painter. Only the ACTIVE skin is
// baked — swapping repaints the same 24 atlas tiles in place (setWizardSkin),
// so any number of skins costs the atlas space of one. All values are solid
// hex colours; the painter derives its soft-glow alphas from them.
export interface WizardSkin {
  robeOuter: [string, string];   // gradient, shoulders → hem
  robeInner: [string, string];
  specks: [string, string, string, string]; // woven-star twinkle colours
  rim: string;                   // side rim-light
  trim: string;                  // belt, hat band, tip star, staff crescent
  buckle: string;                // bright diamond at the belt
  sigil: string;                 // moon sigil stroke
  sigilGlow: string;
  skinTone: string;              // face + hands
  eyeDot: string;
  beard: string;
  beardShade: string;
  hatBrim: string;
  hatBrimTop: string;
  hatCone: [string, string];     // gradient, base → tip
  staffWood: string;
  staffSheen: string;
  orb: string;                   // baked orb core in the sheet
  orbGlow: string;               // live staff-orb halo (emitted by render.ts)
  orbCore: string;               // live staff-orb hot centre
  // Optional themed staff head, drawn in the wizard's feet-anchored local
  // space around (14,-48) in place of the default crescent + orb. The live
  // orb glow (orbGlow/orbCore) still pulses over it on casts.
  staffHead?: (ctx: CanvasRenderingContext2D) => void;
  // Optional chest emblem drawn centred on (0,-4) in place of the default
  // moon sigil (the sigilGlow halo is painted beneath either way).
  chest?: (ctx: CanvasRenderingContext2D) => void;
}

export const DEFAULT_WIZARD_SKIN: WizardSkin = {
  robeOuter: ['#2b2058', '#181140'],
  robeInner: ['#46329a', '#2b1f61'],
  specks: ['#ffd27a', '#8fe8ff', '#e6d1ff', '#fff2cc'],
  rim: '#b48cff',
  trim: '#ffd27a',
  buckle: '#fff2cc',
  sigil: '#bff1ff',
  sigilGlow: '#8fe8ff',
  skinTone: '#f2d9c0',
  eyeDot: '#1a1330',
  beard: '#d9d4f2',
  beardShade: '#968ccd',
  hatBrim: '#221850',
  hatBrimTop: '#352a70',
  hatCone: ['#332566', '#4a37a0'],
  staffWood: '#5a3d22',
  staffSheen: '#ffdca0',
  orb: '#bff9ff',
  orbGlow: '#80f5ff',
  orbCore: '#f0ffff',
};

// The Other Dreamer as he first appears: the wizard's own silhouette drained
// of every warm colour — grave-dark cloth, ashen skin, embers where stars
// should be, and eyes that answer in red. Baked once as its own frame set
// (dwiz:*), independent of the player's chosen skin.
export const DARK_WIZARD_SKIN: WizardSkin = {
  robeOuter: ['#1c0d22', '#070310'],
  robeInner: ['#331124', '#160812'],
  specks: ['#ff3d5e', '#8a1030', '#c22246', '#ff7a8e'],
  rim: '#ff2e4d',
  trim: '#7a1226',
  buckle: '#ff3d5e',
  sigil: '#ff3d5e',
  sigilGlow: '#ff2040',
  skinTone: '#9a93ad',
  eyeDot: '#ff2040',
  beard: '#3a3247',
  beardShade: '#17101f',
  hatBrim: '#0d0714',
  hatBrimTop: '#1c1026',
  hatCone: ['#150a1e', '#2a1031'],
  staffWood: '#2a1018',
  staffSheen: '#ff3d5e',
  orb: '#ff2040',
  orbGlow: '#ff2040',
  orbCore: '#ffd7dd',
};

export function darkWizardFrameId(frame: number): string { return `dwiz:${frame}`; }

let _skin: WizardSkin = DEFAULT_WIZARD_SKIN;

export function getWizardSkin(): WizardSkin { return _skin; }

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function paintWizard(ctx: CanvasRenderingContext2D, ph: number, skin: WizardSkin) {
  ctx.translate(0, WIZARD_CY); // paint in original feet-anchored coords
  const hemT = ph * TAU;

  // the robe silhouette — the engine's hurtbox is tuned to it
  const robe = (w1: number, w2: number, hY: number, fill: string | CanvasGradient) => {
    ctx.fillStyle = fill;
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
  // a piece of the night sky: deeper toward the hem, lighter at the shoulders
  robe(9, 16, 8, linGrad(ctx, 0, -26, 0, 10, skin.robeOuter[0], skin.robeOuter[1]));
  robe(8, 13, 5, linGrad(ctx, 0, -26, 0, 8, skin.robeInner[0], skin.robeInner[1]));

  // stars woven into the cloth, twinkling out of phase (loop-safe sin terms)
  ctx.globalCompositeOperation = 'lighter';
  const [spA, spB, spC, spD] = skin.specks;
  const SPECKS: [number, number, number, string][] = [
    [-6, -20, 2.0, spA],
    [5, -16, 1.6, spB],
    [0, -10, 1.3, spC],
    [-8, -4, 1.7, spB],
    [7, -5, 2.0, spA],
    [-3, 1, 1.4, spD],
  ];
  for (let k = 0; k < SPECKS.length; k++) {
    const [sx, sy, sr, c] = SPECKS[k];
    const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(hemT + k * 2.7));
    ctx.globalAlpha = tw;
    ctx.fillStyle = c;
    ctx.beginPath(); // four-point sparkle
    ctx.moveTo(sx, sy - sr);
    ctx.lineTo(sx + sr * 0.36, sy);
    ctx.lineTo(sx, sy + sr);
    ctx.lineTo(sx - sr * 0.36, sy);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx - sr, sy);
    ctx.lineTo(sx, sy + sr * 0.36);
    ctx.lineTo(sx + sr, sy);
    ctx.lineTo(sx, sy - sr * 0.36);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // rim light: a violet whisper on both sides — it lifts the figure out of the
  // dark like the enemies' own glows do
  const rimC = withAlpha(skin.rim, 0.25);
  ctx.strokeStyle = rimC;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(9, -26);
  ctx.quadraticCurveTo(18, -6, 16, 7);
  ctx.stroke();
  ctx.strokeStyle = rimC;
  ctx.beginPath();
  ctx.moveTo(-9, -26);
  ctx.quadraticCurveTo(-18, -6, -16, 7);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';

  // belt with a soft gold breath at the buckle
  ctx.fillStyle = skin.trim;
  ctx.fillRect(-8, -14, 16, 2.4);
  softGlow(ctx, 0, -12.8, 5, withAlpha(skin.trim, 0.4));
  ctx.fillStyle = skin.buckle;
  ctx.beginPath(); // small diamond buckle
  ctx.moveTo(0, -15.2); ctx.lineTo(2, -12.8); ctx.lineTo(0, -10.4); ctx.lineTo(-2, -12.8);
  ctx.closePath(); ctx.fill();

  // chest sigil, luminous (the bloom pass picks it up): the moon by default,
  // the mastered spell's own icon on themed vestments
  softGlow(ctx, 0, -4, 7, withAlpha(skin.sigilGlow, 0.4));
  if (skin.chest) {
    skin.chest(ctx);
  } else {
    ctx.strokeStyle = skin.sigil;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, -4, 4.4, 0.7, TAU - 0.7);
    ctx.stroke();
  }

  // staff arm
  ctx.strokeStyle = skin.skinTone;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(4, -22); ctx.lineTo(13, -26); ctx.stroke();

  // head
  ctx.fillStyle = skin.skinTone;
  ctx.beginPath(); ctx.arc(1, -32, 6.5, 0, TAU); ctx.fill();
  ctx.fillStyle = skin.eyeDot;
  ctx.beginPath(); ctx.arc(3.4, -33, 1, 0, TAU); ctx.fill();

  // a magus beard: silver-lavender, drifting with the same breeze as the hem
  const bw = Math.sin(hemT + 1.2) * 0.8;
  ctx.fillStyle = skin.beard;
  ctx.beginPath();
  ctx.moveTo(-3.5, -29.5);
  ctx.quadraticCurveTo(-4.5, -24, -1.5 + bw, -20);
  ctx.quadraticCurveTo(1.5 + bw, -18.5, 3.5 + bw * 0.5, -21);
  ctx.quadraticCurveTo(5.5, -25, 4.8, -28.5);
  ctx.quadraticCurveTo(1, -26.5, -3.5, -29.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = withAlpha(skin.beardShade, 0.45); // a little depth in the strands
  ctx.beginPath();
  ctx.moveTo(-1.5, -27.5);
  ctx.quadraticCurveTo(-2, -23.5, 0 + bw, -20.5);
  ctx.quadraticCurveTo(0.8, -24, 0.4, -27);
  ctx.closePath();
  ctx.fill();

  // hat: brim with underside depth, gradient cone, gold band, tip star
  const hatBend = Math.sin(hemT * 0.5) * 1.5;
  ctx.fillStyle = skin.hatBrim;
  ctx.beginPath(); ctx.ellipse(0.5, -35.6, 13.5, 3.6, -0.06, 0, TAU); ctx.fill();
  ctx.fillStyle = skin.hatBrimTop;
  ctx.beginPath(); ctx.ellipse(0.5, -36.4, 13.2, 3.3, -0.06, 0, TAU); ctx.fill();
  ctx.fillStyle = linGrad(ctx, 0, -37, 0, -58, skin.hatCone[0], skin.hatCone[1]);
  ctx.beginPath();
  ctx.moveTo(-7.5, -37);
  ctx.quadraticCurveTo(-3, -52, 2 + hatBend, -56);
  ctx.quadraticCurveTo(7 + hatBend, -58, 4 + hatBend, -50);
  ctx.quadraticCurveTo(7, -44, 8, -37.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = skin.trim; // hat band at the cone's base
  ctx.fillRect(-5.5, -39.8, 11.5, 1.9);
  ctx.save(); // the slowly-spinning tip star, now breathing light
  softGlow(ctx, 3.5 + hatBend, -54, 6, withAlpha(skin.trim, 0.5));
  ctx.translate(3.5 + hatBend, -54);
  ctx.rotate(ph * TAU);
  ctx.fillStyle = skin.trim;
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

  // staff: driftwood with a moonlit edge and a crescent cradling the orb
  // (orb glow/core stay LIVE quads at (14,-48) so casts can pulse them)
  ctx.strokeStyle = skin.staffWood;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(14, 6);
  ctx.quadraticCurveTo(15.5, -20, 14, -44);
  ctx.stroke();
  ctx.strokeStyle = withAlpha(skin.staffSheen, 0.3);
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(13.2, 5);
  ctx.quadraticCurveTo(14.7, -20, 13.3, -43);
  ctx.stroke();
  if (skin.staffHead) {
    skin.staffHead(ctx);
  } else {
    ctx.strokeStyle = skin.trim;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath(); // crescent cup under the orb
    ctx.arc(14, -47, 5.2, Math.PI * 0.18, Math.PI * 0.82);
    ctx.stroke();
    ctx.fillStyle = skin.orb;
    ctx.beginPath(); ctx.arc(14, -48, 3.6, 0, TAU); ctx.fill();
  }
}

// Paint the wizard once into a size×size canvas — for skin previews in menus.
// Draws in the same feet-anchored local space the atlas bakes, centred on the
// figure's midpoint.
export function paintWizardPreview(ctx: CanvasRenderingContext2D, size: number, skin?: Partial<WizardSkin>, ph = 0) {
  const s: WizardSkin = { ...DEFAULT_WIZARD_SKIN, ...skin };
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  const sc = size / (WIZARD_HALF * 2 - 12); // trim the padded margin so the figure fills the tile
  ctx.setTransform(sc, 0, 0, sc, size / 2, size / 2);
  paintWizard(ctx, ph, s);
  ctx.restore();
}

export function wizardFrameId(frame: number): string { return `wiz:${frame}`; }

// stable sprite id for an enemy body frame (tint applied per-instance now)
export function enemyFrameId(type: string, frame: number): string {
  return `e:${type}:${frame}`;
}

// ============================================================ sprite atlas
// One texture holding every sprite. Each entry records its UV rect and its
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
  version: number;                    // bumped on repaint → GPU re-uploads
}

let _atlas: Atlas | null = null;

// A small extra painter set for the non-enemy world sprites. Each draws
// centred at (0,0) in a local space of half-extent `half`. Particle shape
// sprites (p:*) are baked white so the per-instance tint colours them exactly.
interface ExtraSprite { id: string; half: number; paint: (ctx: CanvasRenderingContext2D) => void }

function extraSprites(): ExtraSprite[] {
  const out: ExtraSprite[] = [];
  // gem variants
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
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
      g.addColorStop(0, 'rgba(159,216,255,0.28)'); g.addColorStop(1, 'rgba(159,216,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 20, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      for (const side of [0, Math.PI]) {
        ctx.save();
        ctx.rotate(side);
        ctx.fillStyle = '#e8f6ff';
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.quadraticCurveTo(20, -18, 30, -4);
        ctx.quadraticCurveTo(20, -7, 8, 5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#9fd8ff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(8, 1);
        ctx.quadraticCurveTo(20, -8, 30, -4);
        ctx.stroke();
        ctx.restore();
      }
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
  // a plain soft white glow quad, tinted per-instance (halos, particles, shadows)
  out.push({
    id: 'glow', half: 32, paint(ctx) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 32);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 32, 0, TAU); ctx.fill();
    },
  });
  // eye iris: pink orb + dark pupil + white highlight, rotated per-instance
  // toward the player (the eye body is baked iris-less).
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
  // slowly, so the motion is continuous at any scale.
  out.push({
    id: 'tentacles', half: 34, paint(ctx) {
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
  // warlock floating grimoire (live quad, tinted per-instance — bobs/tilts on
  // the smooth clock)
  out.push({
    id: 'grimoire', half: 7, paint(ctx) {
      ctx.fillStyle = '#3d2159';
      ctx.fillRect(-5, -3.5, 10, 7);
      ctx.fillStyle = '#e3bfff';
      ctx.fillRect(-4, -2.5, 4, 5);
      ctx.fillRect(0.5, -2.5, 3.5, 5);
      ctx.fillStyle = 'rgba(255,154,213,0.7)';
      ctx.beginPath(); ctx.arc(2.2, 0, 1.1, 0, TAU); ctx.fill();
    },
  });
  // fallen-star pickup: the five-pointed cyan star core (rotates live)
  out.push({
    id: 'pickup:star', half: 12, paint(ctx) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 12);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, '#7ff5ff'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.fill();
      ctx.fillStyle = '#eafeff';
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU - Math.PI / 2;
        const a2 = a + TAU / 10;
        ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
        ctx.lineTo(Math.cos(a2) * 4.2, Math.sin(a2) * 4.2);
      }
      ctx.closePath(); ctx.fill();
    },
  });
  // fallen-star pickup: the vertical "beacon" — a tall bright column fading to
  // transparent at the top, painted in the TOP half of a square tile. Emitted
  // additively with the quad centred on the star so the column rises upward.
  out.push({
    id: 'pickup:beacon', half: 96, paint(ctx) {
      const g = ctx.createLinearGradient(0, -96, 0, 0);
      g.addColorStop(0, 'rgba(127,245,255,0)');
      g.addColorStop(1, 'rgba(127,245,255,0.32)');
      ctx.fillStyle = g;
      ctx.fillRect(-7, -96, 14, 96);
    },
  });
  // spirit lantern body (Lantern zone): frame + glass, flame glow drawn live
  out.push({
    id: 'lantern', half: 14, paint(ctx) {
      ctx.fillStyle = '#1a3a34';
      ctx.fillRect(-5, -11, 10, 3);
      ctx.fillRect(-4, 8, 8, 2.5);
      ctx.strokeStyle = '#4ad9c4';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-5.5, -8, 11, 16);
      ctx.fillStyle = '#4ad9c4';
      ctx.beginPath(); ctx.ellipse(0, 0, 3, 4.5, 0, 0, TAU); ctx.fill();
    },
  });

  // ---------------- particle shape sprites (white → per-instance tint) ------
  // four-point sparkle (mode 'star'); outer radius = half so quadHalf = size
  out.push({
    id: 'p:star', half: 16, paint(ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a - 0.18) * 16 * 0.35, Math.sin(a - 0.18) * 16 * 0.35);
        ctx.lineTo(Math.cos(a) * 16, Math.sin(a) * 16);
        ctx.lineTo(Math.cos(a + 0.18) * 16 * 0.35, Math.sin(a + 0.18) * 16 * 0.35);
      }
      ctx.closePath(); ctx.fill();
    },
  });
  // crystal shard diamond (mode 'shard') with a brighter core facet
  out.push({
    id: 'p:shard', half: 16, paint(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(0, -16); ctx.lineTo(6.1, 0); ctx.lineTo(0, 16); ctx.lineTo(-6.1, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -8.8); ctx.lineTo(2.9, 0); ctx.lineTo(0, 8.8); ctx.lineTo(-2.9, 0);
      ctx.closePath(); ctx.fill();
    },
  });
  // falling blossom petal (mode 'petal')
  out.push({
    id: 'p:petal', half: 16, paint(ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(0, -7, 4.8, 8.8, 0, 0, TAU);
      ctx.fill();
    },
  });
  // thin shockwave ring (mode 'ring'); expansion driven by quad scale
  out.push({
    id: 'p:ring', half: 32, paint(ctx) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.arc(0, 0, 29, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    },
  });
  // velocity-stretched spark streak (mode 'spark'): bright head at +x, tail -x
  out.push({
    id: 'p:spark', half: 16, paint(ctx) {
      const g = ctx.createLinearGradient(-16, 0, 12, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, '#ffffff');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-16, 0);
      ctx.quadraticCurveTo(2, -3.4, 12, 0);
      ctx.quadraticCurveTo(2, 3.4, -16, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(11, 0, 2.6, 0, TAU); ctx.fill();
    },
  });
  // dream-glyph runes (mode 'rune'), four variants picked by seed
  for (let glyph = 0; glyph < 4; glyph++) {
    out.push({
      id: 'p:rune' + glyph, half: 16, paint(ctx) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        const s = 12;
        ctx.beginPath();
        if (glyph === 0) {
          ctx.moveTo(-s, s); ctx.lineTo(0, -s); ctx.lineTo(s, s);
          ctx.moveTo(-s * 0.5, 0.2 * s); ctx.lineTo(s * 0.5, 0.2 * s);
        } else if (glyph === 1) {
          ctx.moveTo(0, -s); ctx.lineTo(0, s);
          ctx.moveTo(-s * 0.7, -s * 0.4); ctx.lineTo(s * 0.7, s * 0.4);
        } else if (glyph === 2) {
          ctx.arc(0, 0, s * 0.8, 0.4, TAU - 0.4);
          ctx.moveTo(0, -s); ctx.lineTo(0, s * 0.2);
        } else {
          ctx.moveTo(-s, 0); ctx.lineTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.closePath();
        }
        ctx.stroke();
      },
    });
  }
  return out;
}

// Build the atlas: shelf-pack every sprite into a square texture. Enemy frames
// dominate the count (each type bakes its own `frames`, plus the wizard's 24)
// but pack tightly.
export function buildAtlas(): Atlas {
  if (_atlas) return _atlas;

  interface Tile { id: string; half: number; px: number; canvas: HTMLCanvasElement }
  const tiles: Tile[] = [];

  const bake = (id: string, half: number, paint: Painter | ((c: CanvasRenderingContext2D) => void), ph = 0) => {
    const px = Math.ceil((half + PAD) * 2 * SS);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d')!;
    g.setTransform(SS, 0, 0, SS, (half + PAD) * SS, (half + PAD) * SS);
    (paint as Painter)(g, ph);
    tiles.push({ id, half, px, canvas: c });
  };

  // enemy frames (single tint — hit-flash/frozen are per-instance shader mixes)
  for (const type of ENEMY_KINDS) {
    const def = ENEMY_SPRITES[type];
    for (let f = 0; f < def.frames; f++) bake(enemyFrameId(type, f), def.half, def.paint, f / def.frames);
  }
  // wizard frames (active skin only)
  for (let f = 0; f < WIZARD_FRAMES; f++) {
    bake(wizardFrameId(f), WIZARD_HALF, (c: CanvasRenderingContext2D, ph: number) => paintWizard(c, ph, _skin), f / WIZARD_FRAMES);
  }
  // the dark wizard (finale cutscene actor) — same painter, drained palette
  for (let f = 0; f < WIZARD_FRAMES; f++) {
    bake(darkWizardFrameId(f), WIZARD_HALF, (c: CanvasRenderingContext2D, ph: number) => paintWizard(c, ph, DARK_WIZARD_SKIN), f / WIZARD_FRAMES);
  }
  // extra sprites
  for (const es of extraSprites()) bake(es.id, es.half, es.paint);

  // shelf pack, tallest-first, into a power-of-two square
  tiles.sort((a, b) => b.px - a.px);
  const totalArea = tiles.reduce((s, t) => s + t.px * t.px, 0);
  let size = 256;
  // Initial size GUESS only — the pack loop below grows `size` if tiles don't
  // fit. The 1.2 headroom covers shelf-packing waste without overshooting to
  // the next power of two.
  while (size * size < totalArea * 1.2) size *= 2;
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

  _atlas = { canvas, size, entries, version: 0 };
  return _atlas;
}

export function getAtlas(): Atlas { return _atlas || buildAtlas(); }

// Pre-bake up front (one-time) so the first heavy frame doesn't stall.
export function prebakeSprites() { buildAtlas(); }

// Swap the player's palette. Wizard tile rects and UVs are skin-independent,
// so only the 24 wizard tiles are repainted in place and the atlas version is
// bumped for the GPU renderer to re-upload. Any number of skins therefore
// costs the atlas space (and bake time) of exactly one.
export function setWizardSkin(skin: Partial<WizardSkin>) {
  _skin = { ...DEFAULT_WIZARD_SKIN, ...skin };
  if (!_atlas) return;
  const { canvas, size, entries } = _atlas;
  const ctx = canvas.getContext('2d')!;
  for (let f = 0; f < WIZARD_FRAMES; f++) {
    const e = entries.get(wizardFrameId(f))!;
    const x = e.u0 * size, y = e.v0 * size;
    const px = (e.u1 - e.u0) * size;
    ctx.save();
    ctx.clearRect(x, y, px, px);
    ctx.beginPath(); ctx.rect(x, y, px, px); ctx.clip();
    ctx.setTransform(SS, 0, 0, SS, x + (WIZARD_HALF + PAD) * SS, y + (WIZARD_HALF + PAD) * SS);
    paintWizard(ctx, f / WIZARD_FRAMES, _skin);
    ctx.restore();
  }
  _atlas.version++;
}

// ---- local baking helpers ----
function radial(ctx: CanvasRenderingContext2D, r: number, c0: string, c1: string): CanvasGradient {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, c0);
  if (c1.startsWith('rgba') && c1.endsWith(',0)')) { g.addColorStop(1, c1); }
  else { g.addColorStop(0.45, c1); g.addColorStop(1, 'rgba(0,0,0,0)'); }
  return g;
}
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
