// Wizard skins — one per spell evolution, unlocked by awakening that spell's
// evolution star in the Constellation. Each skin is a full re-dye of the robe,
// hat and trims in the spell's palette plus a bespoke staff head, so the
// dreamer visibly carries the school they mastered. Named after the evolution.
//
// Only the ACTIVE skin is ever baked (see setWizardSkin): the atlas holds the
// wizard sheet once, whatever this file grows to.

import { setWizardSkin, type WizardSkin } from './enemySprites';
import { SPELLS, EVOLVE } from './spells';
import { ICON_PARTS } from './spellIcons';

type Ctx = CanvasRenderingContext2D;
const TAU = Math.PI * 2;

// staff head anchor in the wizard's feet-local space — the live cast glow
// (orbGlow/orbCore quads) pulses at exactly this point, so heads centre here
const HX = 14, HY = -48;

function channel(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const ca = channel(a), cb = channel(b);
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = channel(hex);
  return `rgba(${r},${g},${b},${a})`;
}
const dusk = (c: string, t: number) => mix(c, '#0b0722', t);
const pale = (c: string, t: number) => mix(c, '#ffffff', t);
const lum = (c: string) => { const [r, g, b] = channel(c); return 0.299 * r + 0.587 * g + 0.114 * b; };

function glow(ctx: Ctx, x: number, y: number, r: number, hex: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(hex, a));
  g.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}
function starPath(ctx: Ctx, x: number, y: number, n: number, R: number, r: number, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * TAU;
    const a2 = a + TAU / (n * 2);
    ctx.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
    ctx.lineTo(x + Math.cos(a2) * r, y + Math.sin(a2) * r);
  }
  ctx.closePath();
}

// The spell's own icon, stamped on the chest where the old robe wears its
// moon. ICON_PARTS geometry lives in a 24×24 viewBox; scaled here to the
// sigil's footprint between belt and hem.
function chestIcon(spellId: string, color: string): (ctx: Ctx) => void {
  return (ctx) => {
    ctx.save();
    ctx.translate(0, -4);
    ctx.scale(0.4, 0.4);
    ctx.translate(-12, -12);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const part of ICON_PARTS[spellId] || []) {
      const p = new Path2D();
      if (part.d) p.addPath(new Path2D(part.d));
      else p.arc(part.c![0], part.c![1], part.c![2], 0, TAU);
      ctx.globalAlpha = part.opacity ?? 1;
      if (part.fill) ctx.fill(p); else ctx.stroke(p);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };
}

// The common re-dye: robe/hat sink toward night in the spell's hue (robeHue
// overrides when the spell colour is too pale to darken well), trims take the
// brighter of the spell's two colours, and the live cast-glow follows suit.
function vestment(spellId: string, over: Partial<WizardSkin> = {}, robeHue?: string): Partial<WizardSkin> {
  const { color, color2 } = SPELLS[spellId];
  const bright = lum(color) >= lum(color2) ? color : color2;
  const hue = robeHue || color;
  return {
    robeOuter: [dusk(hue, 0.74), dusk(hue, 0.88)],
    robeInner: [dusk(hue, 0.55), dusk(hue, 0.74)],
    hatBrim: dusk(hue, 0.84),
    hatBrimTop: dusk(hue, 0.7),
    hatCone: [dusk(hue, 0.68), dusk(hue, 0.52)],
    specks: [bright, color, pale(hue, 0.7), '#fff2cc'],
    rim: pale(hue, 0.3),
    trim: bright,
    buckle: pale(bright, 0.6),
    sigil: pale(color, 0.6),
    sigilGlow: color,
    chest: chestIcon(spellId, pale(color, 0.6)),
    orb: pale(color, 0.45),
    orbGlow: color,
    orbCore: pale(color, 0.85),
    ...over,
  };
}

export const WIZARD_SKINS: Record<string, Partial<WizardSkin>> = {
  // Pyre Bloom — a brazier of living flame crowns the staff
  ember: vestment('ember', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 10, '#ff8c5a', 0.5);
      ctx.strokeStyle = '#ffd27a';
      ctx.lineWidth = 1.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(HX, HY + 1, 4.6, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      ctx.fillStyle = '#ff8c5a';
      ctx.beginPath();
      ctx.moveTo(HX - 4, HY + 2.5);
      ctx.quadraticCurveTo(HX - 5.5, HY - 2, HX - 2.5, HY - 5);
      ctx.quadraticCurveTo(HX - 1.5, HY - 1.5, HX, HY - 3);
      ctx.quadraticCurveTo(HX + 0.5, HY - 8, HX + 3, HY - 10.5);
      ctx.quadraticCurveTo(HX + 3.5, HY - 4.5, HX + 5, HY - 5.5);
      ctx.quadraticCurveTo(HX + 6, HY - 1, HX + 4, HY + 2.5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath(); ctx.ellipse(HX + 0.5, HY - 1, 2, 3.2, 0.1, 0, TAU); ctx.fill();
    },
  }),

  // Arcane Torrent — a core orb ringed by three hungry shards
  arcane: vestment('arcane', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#b48cff', 0.55);
      ctx.fillStyle = '#e6d1ff';
      ctx.beginPath(); ctx.arc(HX, HY, 2.6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#b48cff';
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k / 3) * TAU;
        const px = HX + Math.cos(a) * 5.6, py = HY + Math.sin(a) * 5.6;
        ctx.save();
        ctx.translate(px, py); ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(2.4, 0); ctx.lineTo(0, 1.4); ctx.lineTo(-1.6, 0); ctx.lineTo(0, -1.4);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    },
  }),

  // Winterloom — a six-armed frost sigil, forever mid-fall
  frost: vestment('frost', {
    beard: '#eaf6ff', beardShade: '#9fc4d9',
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#8fe8ff', 0.5);
      ctx.strokeStyle = '#e8fbff';
      ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU;
        const cs = Math.cos(a), sn = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(HX, HY); ctx.lineTo(HX + cs * 5.6, HY + sn * 5.6);
        ctx.moveTo(HX + cs * 3.4 - sn * 1.5, HY + sn * 3.4 + cs * 1.5);
        ctx.lineTo(HX + cs * 4.6, HY + sn * 4.6);
        ctx.lineTo(HX + cs * 3.4 + sn * 1.5, HY + sn * 3.4 - cs * 1.5);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(HX, HY, 1.4, 0, TAU); ctx.fill();
    },
  }),

  // Skyfracture — a bolt arcs between two storm-catcher prongs
  storm: vestment('storm', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#7ad7ff', 0.55);
      ctx.strokeStyle = '#7ad7ff';
      ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(HX, HY + 4); ctx.quadraticCurveTo(HX - 4.5, HY + 2, HX - 4.5, HY - 4);
      ctx.moveTo(HX, HY + 4); ctx.quadraticCurveTo(HX + 4.5, HY + 2, HX + 4.5, HY - 4);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(HX + 1, HY - 7.5);
      ctx.lineTo(HX - 2.2, HY - 1.5); ctx.lineTo(HX + 0.2, HY - 1.2);
      ctx.lineTo(HX - 1.4, HY + 3.5); ctx.lineTo(HX + 2.4, HY - 2.2);
      ctx.lineTo(HX + 0.2, HY - 2.6);
      ctx.closePath(); ctx.fill();
    },
  }),

  // Event Horizon — a black orb wearing a tilted accretion ring
  void: vestment('void', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 10, '#9a5cff', 0.55);
      ctx.fillStyle = '#0b0616';
      ctx.beginPath(); ctx.arc(HX, HY, 4, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#c9a4ff';
      ctx.lineWidth = 1.2;
      ctx.save();
      ctx.translate(HX, HY); ctx.rotate(-0.45);
      ctx.beginPath(); ctx.ellipse(0, 0, 6.4, 2, 0, 0, TAU); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(HX - 1.4, HY - 1.6, 0.9, 0, TAU); ctx.fill();
    },
  }),

  // Wild Garden — a spirit blossom in perpetual bloom
  petals: vestment('petals', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#7dffb0', 0.45);
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k % 2 ? '#ffd1ec' : '#7dffb0';
        ctx.save();
        ctx.translate(HX, HY); ctx.rotate((k / 5) * TAU);
        ctx.beginPath(); ctx.ellipse(0, -3.6, 1.8, 3.4, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath(); ctx.arc(HX, HY, 1.7, 0, TAU); ctx.fill();
    },
  }),

  // Eclipsing Lance — the moon itself, cradled at the staff's tip
  moon: vestment('moon', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 10, '#fff3b8', 0.5);
      ctx.fillStyle = '#fff3b8';
      ctx.beginPath();
      ctx.arc(HX, HY, 5, Math.PI * 0.42, Math.PI * 1.58);
      ctx.arc(HX + 2, HY, 3.9, Math.PI * 1.52, Math.PI * 0.48, true);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#bcd9ff';
      starPath(ctx, HX + 4, HY - 3.5, 4, 1.8, 0.7);
      ctx.fill();
    },
  }, '#5a6fd9'),

  // Cosmic Ruin — a star caught mid-fall, its trail still burning
  starfall: vestment('starfall', {
    staffHead(ctx) {
      glow(ctx, HX + 1, HY + 1, 9, '#ffb3f2', 0.55);
      ctx.fillStyle = rgba('#8a7bff', 0.7);
      ctx.beginPath(); ctx.arc(HX + 4.5, HY - 5, 1.2, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba('#8a7bff', 0.4);
      ctx.beginPath(); ctx.arc(HX + 7, HY - 8.5, 0.9, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff';
      starPath(ctx, HX + 1, HY + 1, 5, 4.6, 1.9);
      ctx.fill();
    },
  }),

  // Night's Teeth — twin shadow fangs, bared
  umbra: vestment('umbra', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#8a5cd9', 0.5);
      ctx.fillStyle = '#b28aff';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(HX + side * 0.5, HY - 5.5);
        ctx.quadraticCurveTo(HX + side * 6.5, HY - 3.5, HX + side * 3.5, HY + 5);
        ctx.quadraticCurveTo(HX + side * 2.5, HY - 1, HX + side * 0.5, HY - 5.5);
        ctx.closePath(); ctx.fill();
      }
    },
  }),

  // Star Sovereign — a twin star-blade, forever turning
  glaive: vestment('glaive', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#9fd8ff', 0.5);
      ctx.fillStyle = '#e8f6ff';
      for (const rot of [0, Math.PI]) {
        ctx.save();
        ctx.translate(HX, HY); ctx.rotate(rot + 0.5);
        ctx.beginPath();
        ctx.moveTo(1.4, 0);
        ctx.quadraticCurveTo(4.5, -4, 7, -1);
        ctx.quadraticCurveTo(4.5, -1.6, 1.8, 1.2);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(HX, HY, 1.6, 0, TAU); ctx.fill();
    },
  }),

  // Genesis Cloud — a newborn nebula drifting above the wood
  nebula: vestment('nebula', {
    staffHead(ctx) {
      glow(ctx, HX - 2.5, HY + 1, 5.5, '#c48cff', 0.85);
      glow(ctx, HX + 2.5, HY - 1, 5.5, '#ff9ad5', 0.75);
      glow(ctx, HX, HY - 2.5, 4.5, '#e6d1ff', 0.85);
      ctx.fillStyle = rgba('#e6d1ff', 0.5);
      ctx.beginPath(); ctx.arc(HX, HY, 3, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(HX - 2, HY + 1.5, 0.8, 0, TAU);
      ctx.arc(HX + 2.5, HY - 2, 0.7, 0, TAU);
      ctx.fill();
    },
  }),

  // The Great Seal — a rune-ring, armed and waiting
  sigil: vestment('sigil', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#ffd27a', 0.5);
      ctx.strokeStyle = '#ffd27a';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(HX, HY, 5, 0, TAU); ctx.stroke();
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k / 3) * TAU;
        ctx.lineTo(HX + Math.cos(a) * 3.4, HY + Math.sin(a) * 3.4);
      }
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = '#b48cff';
      ctx.beginPath(); ctx.arc(HX, HY, 1.3, 0, TAU); ctx.fill();
    },
  }, '#b48cff'),

  // Lantern Procession — one small soul-light hangs from a shepherd's hook
  lantern: vestment('lantern', {
    staffHead(ctx) {
      ctx.strokeStyle = '#5a3d22';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(HX, HY + 4);
      ctx.quadraticCurveTo(HX + 0.5, HY - 7, HX + 5.5, HY - 6);
      ctx.stroke();
      const lx = HX + 5.5, ly = HY - 1;
      glow(ctx, lx, ly, 8, '#4ad9c4', 0.55);
      ctx.strokeStyle = '#1a3a34';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(lx, ly - 5.5); ctx.lineTo(lx, ly - 3.4); ctx.stroke();
      ctx.fillStyle = '#1a3a34';
      ctx.fillRect(lx - 2, ly - 3.8, 4, 1.2);
      ctx.fillRect(lx - 1.6, ly + 2.6, 3.2, 1);
      ctx.strokeStyle = '#4ad9c4';
      ctx.strokeRect(lx - 2.2, ly - 2.6, 4.4, 5.2);
      ctx.fillStyle = '#a8ffe8';
      ctx.beginPath(); ctx.ellipse(lx, ly, 1.3, 1.9, 0, 0, TAU); ctx.fill();
    },
  }),

  // Endless Dusk — a dusk-disc, its second wave already leaving
  nova: vestment('nova', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 10, '#ff9ad5', 0.5);
      ctx.strokeStyle = rgba('#ff9ad5', 0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(HX, HY, 6.4, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#5a2a6e';
      ctx.beginPath(); ctx.arc(HX, HY, 3.6, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#ff9ad5';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(HX, HY, 3.6, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#fff6f9';
      ctx.beginPath(); ctx.arc(HX, HY, 1.1, 0, TAU); ctx.fill();
    },
  }),

  // Choir Eternal — three wisps hold their note above the staff
  wisps: vestment('wisps', {
    staffHead(ctx) {
      const dots: [number, number, number][] = [[HX, HY - 4.5, 1.5], [HX - 4, HY + 2, 1.2], [HX + 4, HY + 2, 1.2]];
      for (const [x, y, r] of dots) {
        glow(ctx, x, y, r * 3.6, '#8cf7e2', 0.8);
        ctx.fillStyle = '#eafeff';
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
    },
  }),

  // Leviathan of Sleep — a water-serpent winds the staff itself
  serpent: vestment('serpent', {
    staffHead(ctx) {
      glow(ctx, HX, HY - 2, 9, '#5ad7c9', 0.45);
      ctx.strokeStyle = '#5ad7c9';
      ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(HX - 3, HY + 7);
      ctx.quadraticCurveTo(HX + 4.5, HY + 5, HX - 0.5, HY + 1);
      ctx.quadraticCurveTo(HX - 5, HY - 2.5, HX + 0.5, HY - 5);
      ctx.quadraticCurveTo(HX + 3.5, HY - 6.5, HX + 2, HY - 8.5);
      ctx.stroke();
      ctx.fillStyle = '#8cf7e2';
      ctx.beginPath(); ctx.arc(HX + 1.8, HY - 8.8, 1.9, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0b2530';
      ctx.beginPath(); ctx.arc(HX + 2.6, HY - 9.3, 0.6, 0, TAU); ctx.fill();
    },
  }),

  // The Last Hour — a bell that has almost finished tolling
  chime: vestment('chime', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#ffd9a0', 0.45);
      ctx.fillStyle = '#ffd9a0';
      ctx.beginPath();
      ctx.moveTo(HX - 3.8, HY + 2.5);
      ctx.quadraticCurveTo(HX - 4.2, HY - 4.5, HX, HY - 5.2);
      ctx.quadraticCurveTo(HX + 4.2, HY - 4.5, HX + 3.8, HY + 2.5);
      ctx.lineTo(HX + 4.8, HY + 3.6);
      ctx.lineTo(HX - 4.8, HY + 3.6);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#b08a4a';
      ctx.beginPath(); ctx.arc(HX, HY + 5, 1.2, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(HX, HY - 5.6, 1, 0, TAU); ctx.fill();
    },
  }),

  // Aurora Crown — the sleepless eye, opened at the staff's tip
  eye: vestment('eye', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#fff7c9', 0.5);
      ctx.fillStyle = '#fff7c9';
      ctx.beginPath();
      ctx.moveTo(HX - 6, HY);
      ctx.quadraticCurveTo(HX, HY - 5.5, HX + 6, HY);
      ctx.quadraticCurveTo(HX, HY + 5.5, HX - 6, HY);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffb3f2';
      ctx.beginPath(); ctx.arc(HX, HY, 2.3, 0, TAU); ctx.fill();
      ctx.fillStyle = '#1a0a14';
      ctx.beginPath(); ctx.arc(HX, HY, 1, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(HX - 0.9, HY - 0.9, 0.5, 0, TAU); ctx.fill();
    },
  }, '#ffb3f2'),

  // The Devouring Name — the brand itself, red and patient
  brand: vestment('brand', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#ff5a7a', 0.6);
      ctx.strokeStyle = '#ff5a7a';
      ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(HX, HY, 4.2, 0, TAU); ctx.stroke();
      ctx.beginPath();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        ctx.moveTo(HX + dx * 4.2, HY + dy * 4.2);
        ctx.lineTo(HX + dx * 6.4, HY + dy * 6.4);
      }
      ctx.stroke();
      ctx.fillStyle = '#ffd6da';
      ctx.beginPath(); ctx.arc(HX, HY, 1.5, 0, TAU); ctx.fill();
    },
  }),

  // Looking-Glass Aegis — a pane of dream-glass, unbroken
  ward: vestment('ward', {
    staffHead(ctx) {
      glow(ctx, HX, HY, 9, '#8fb8ff', 0.45);
      ctx.fillStyle = rgba('#8fb8ff', 0.7);
      ctx.beginPath();
      ctx.moveTo(HX, HY - 6);
      ctx.quadraticCurveTo(HX + 5.2, HY - 5, HX + 5, HY - 1);
      ctx.quadraticCurveTo(HX + 4.8, HY + 3.5, HX, HY + 6);
      ctx.quadraticCurveTo(HX - 4.8, HY + 3.5, HX - 5, HY - 1);
      ctx.quadraticCurveTo(HX - 5.2, HY - 5, HX, HY - 6);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#e6f0ff';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(HX - 2.6, HY - 3.4); ctx.lineTo(HX + 1.8, HY + 3);
      ctx.stroke();
    },
  }),

  // Deep Hush — a sleeping sliver of moon trailing dream-motes
  hush: vestment('hush', {
    staffHead(ctx) {
      glow(ctx, HX - 1, HY + 1, 9, '#b7a7ff', 0.45);
      ctx.fillStyle = '#e9dcff';
      ctx.save();
      ctx.translate(HX - 1, HY + 1); ctx.rotate(0.5);
      ctx.beginPath();
      ctx.arc(0, 0, 4.2, Math.PI * 0.42, Math.PI * 1.58);
      ctx.arc(1.7, 0, 3.3, Math.PI * 1.52, Math.PI * 0.48, true);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = rgba('#b7a7ff', 0.9);
      ctx.beginPath(); ctx.arc(HX + 4.5, HY - 4, 1, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba('#b7a7ff', 0.55);
      ctx.beginPath(); ctx.arc(HX + 6.5, HY - 7, 0.7, 0, TAU); ctx.fill();
    },
  }),

  // The Unblinking Prism — glass apex, rays already leaving
  prism: vestment('prism', {
    staffHead(ctx) {
      glow(ctx, HX + 1, HY, 9, '#f4c9ff', 0.45);
      ctx.strokeStyle = '#9fffe0';
      ctx.lineWidth = 1; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(HX + 4, HY); ctx.lineTo(HX + 9, HY - 4);
      ctx.moveTo(HX + 4, HY); ctx.lineTo(HX + 10, HY);
      ctx.moveTo(HX + 4, HY); ctx.lineTo(HX + 9, HY + 4);
      ctx.stroke();
      ctx.fillStyle = rgba('#f4c9ff', 0.85);
      ctx.beginPath();
      ctx.moveTo(HX + 4.5, HY);
      ctx.lineTo(HX - 4.5, HY - 4.5);
      ctx.lineTo(HX - 4.5, HY + 4.5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    },
  }),
};

export function skinName(id: string): string {
  return EVOLVE[id]?.name ?? id;
}

// Apply the chosen skin ('' = the old robe) to the live sprite atlas.
export function applySkin(id: string) {
  setWizardSkin(id && WIZARD_SKINS[id] ? WIZARD_SKINS[id] : {});
}
