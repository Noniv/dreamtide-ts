// Canvas renderer for the skill webs. The old SVG tree re-rasterized ~360
// retained-mode nodes on every pan frame and got slower with each node added;
// this draws ~700 stars immediate-mode with viewport culling, batched edge
// strokes and zoom-dependent detail, so panning stays flat no matter how big
// the web grows. Also owns the first-discovery reveal, the allocation pulses
// and the hover/hit-testing.
import React, { useEffect, useMemo, useRef } from 'react';
import type { TreeNode, TreeEdge } from './meta';
import { ICON_PARTS } from './spellIcons';

export type TreePhase = 'seed' | 'expanding' | 'done';

// notables and keystones claim visibly more of the space around them than
// travel stars — the hierarchy should read at a glance
export const KIND_R: Record<string, number> = { core: 20, small: 7.5, notable: 14, keystone: 18 };
const KIND_ICON: Record<string, number> = { core: 17, small: 9, notable: 14, keystone: 16.5 };

// nodes that show a bare spell glyph render the drawn icon instead
export function nodeSpellIconId(n: TreeNode): string | null {
  const fx = n.fx || {};
  if (n.kind === 'core' || n.dark) return null;
  if (fx.spell && !fx.evo && !fx.sdmg && !fx.scd && !fx.saoe && !fx.sdur && ICON_PARTS[fx.spell]) return fx.spell;
  return null;
}

const ICON_TABLE: [string, string][] = [
  ['banish', '✕'], ['reroll', '⟳'], ['fourfold', '✥'],
  ['spellSlots', '▣'], ['extraCount', '✚'], ['echo', '⧉'], ['masteryPlus', '⇑'], ['startLv', '✬'],
  ['cheatDeath', '♥'], ['deathBurst', '✺'],
  ['gemMerge', '⬢'], ['golden', '✯'], ['extraGem', '❂'],
  ['surgeAll', '∿'], ['surgeDur', '∿'], ['surgeSpeed', '➳'], ['surgeDmg', '✦'],
  ['surgeHaste', '≋'], ['surgeAoe', '◎'], ['surgeMagnet', '◉'],
  ['baneAhead', '◷'], ['baneHp', '⬡'], ['baneDmg', '⚔'], ['baneSpeed', '➳'],
  ['baneRate', '≋'], ['baneElite', '✸'], ['baneBoss', '☠'], ['baneFloor', '⬢'],
  ['crit', '✸'], ['critDmg', '✸'],
  ['dmg', '✦'], ['cast', '≋'], ['aoe', '◎'], ['speed', '➳'],
  ['hp', '❤'], ['regen', '☽'], ['magnet', '◉'], ['xp', '❂'], ['dust', '✧'],
];

export function nodeIcon(n: TreeNode): string {
  const fx = n.fx || {};
  if (n.kind === 'core') return n.dark ? '❖' : '☉';
  if (fx.spell) {
    if (fx.evo) return '★';
    if (fx.sdmg) return '✦';
    if (fx.scd) return '≋';
    if (fx.saoe) return '◎';
    if (fx.sdur) return '◷';
    return '✦';
  }
  for (const [k, ic] of ICON_TABLE) if (fx[k]) return ic;
  return '';
}

// ---------------------------------------------------------------- palettes
interface Palette {
  edge: string; edgeHalf: string; edgeLit: string;
  body: string; bodyOwned: string; bodyKeystone: string; bodyKeystoneOwned: string;
  coreFill: string; coreStroke: string;
  stroke: string; strokeReach: string; strokeBuy: string; strokeOwned: string; strokeHover: string;
  icon: string; iconLocked: string; iconBuy: string; iconOwned: string;
  glowOwned: string; glowBuy: string; glowCore: string; glowRefund: string;
  pulse: string; wave1: string; wave2: string;
}

const PALETTES: Record<'arcane' | 'dark', Palette> = {
  arcane: {
    edge: 'rgba(205,216,255,0.20)', edgeHalf: 'rgba(180,140,255,0.48)', edgeLit: 'rgba(180,140,255,0.95)',
    body: '#201a45', bodyOwned: '#3b2a78', bodyKeystone: '#1d1440', bodyKeystoneOwned: '#55349e',
    coreFill: '#2c1f63', coreStroke: '#7ff5ff',
    stroke: 'rgba(205,216,255,0.38)', strokeReach: 'rgba(205,216,255,0.75)', strokeBuy: '#ffd27a', strokeOwned: '#b48cff', strokeHover: '#e6ddff',
    icon: 'rgba(205,216,255,0.72)', iconLocked: 'rgba(205,216,255,0.4)', iconBuy: '#ffe9bd', iconOwned: '#ffffff',
    glowOwned: '#b48cff', glowBuy: '#ffd27a', glowCore: '#b48cff', glowRefund: '#ff9ad5',
    pulse: '180,140,255', wave1: 'rgba(203,182,255,', wave2: 'rgba(127,245,255,',
  },
  dark: {
    edge: 'rgba(255,90,122,0.18)', edgeHalf: 'rgba(255,90,122,0.42)', edgeLit: 'rgba(255,90,122,0.95)',
    body: '#1c0812', bodyOwned: '#58122e', bodyKeystone: '#14060d', bodyKeystoneOwned: '#701538',
    coreFill: '#2a0715', coreStroke: '#ff5a7a',
    stroke: 'rgba(255,122,158,0.4)', strokeReach: 'rgba(255,122,176,0.72)', strokeBuy: '#ff5a7a', strokeOwned: '#ff7ab0', strokeHover: '#ffb3c9',
    icon: 'rgba(255,150,180,0.72)', iconLocked: 'rgba(255,150,180,0.38)', iconBuy: '#ffb3cb', iconOwned: '#ffe3ec',
    glowOwned: '#ff5a7a', glowBuy: '#ff5a7a', glowCore: '#ff5a7a', glowRefund: '#ffb3cb',
    pulse: '255,90,122', wave1: 'rgba(255,90,122,', wave2: 'rgba(255,170,120,',
  },
};

// soft radial glow sprites, cached per colour
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement {
  let c = glowCache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'transparent');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(color, c);
  return c;
}

// Path2D cache for the drawn spell icons
interface IconPaths { strokes: Path2D[]; fills: Path2D[] }
const iconPathCache = new Map<string, IconPaths>();
function iconPaths(id: string): IconPaths {
  let out = iconPathCache.get(id);
  if (out) return out;
  out = { strokes: [], fills: [] };
  for (const part of ICON_PARTS[id] || []) {
    let p: Path2D;
    if (part.d) p = new Path2D(part.d);
    else { p = new Path2D(); p.arc(part.c![0], part.c![1], part.c![2], 0, Math.PI * 2); }
    (part.fill ? out.fills : out.strokes).push(p);
  }
  iconPathCache.set(id, out);
  return out;
}

export interface TreeCanvasProps {
  nodes: TreeNode[];
  edges: TreeEdge[];
  nodeMap: Record<string, TreeNode>;
  owned: Set<string>;
  allocatable: Set<string>; // reachable AND a point is available
  removable: Set<string>;   // owned and safe to release
  reachable: Set<string>;   // has a lit neighbour (regardless of points)
  phase: TreePhase;
  coreHot: boolean;         // the core can mint a point right now
  variant: 'arcane' | 'dark';
  fitRadius: number;
  pulse?: { id: string; key: number } | null;
  onNodeClick: (id: string) => void;
  onHoverNode: (id: string | null, x: number, y: number) => void;
  onRevealDone?: () => void;
}

interface EdgeGeom { a: string; b: string; ax: number; ay: number; bx: number; by: number; dist: number }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

export function TreeCanvas(props: TreeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const geom = useMemo(() => {
    const nm = props.nodeMap;
    const eg: EdgeGeom[] = [];
    for (const [a, b] of props.edges) {
      const A = nm[a], B = nm[b];
      if (!A || !B) continue;
      eg.push({ a, b, ax: A.x, ay: A.y, bx: B.x, by: B.y, dist: Math.min(Math.hypot(A.x, A.y), Math.hypot(B.x, B.y)) });
    }
    const nDist = props.nodes.map((n) => Math.hypot(n.x, n.y));
    const maxDist = Math.max(...nDist);
    return { eg, nDist, maxDist };
  }, [props.nodes, props.edges, props.nodeMap]);
  const geomRef = useRef(geom);
  geomRef.current = geom;

  // camera + interaction state live in refs — the rAF loop reads them directly
  const st = useRef({
    camX: 0, camY: 0, z: 0.5, fitZ: 0.5, w: 0, h: 0, dpr: 1,
    dragging: false, dragMoved: false, sx: 0, sy: 0, ox: 0, oy: 0,
    hover: null as string | null,
    revealT0: 0, revealDone: false, revealFrom: 0,
    pulses: [] as { x: number; y: number; r: number; t0: number; big: boolean }[],
    lastPulseKey: -1,
    inited: false,
  });

  // phase change bookkeeping (seed → expanding starts the ignition clock)
  const lastPhase = useRef(props.phase);
  if (lastPhase.current !== props.phase) {
    if (props.phase === 'expanding') {
      st.current.revealT0 = performance.now();
      st.current.revealDone = false;
      st.current.revealFrom = st.current.z;
    }
    lastPhase.current = props.phase;
  }

  // allocation pulse trigger
  if (props.pulse && props.pulse.key !== st.current.lastPulseKey) {
    st.current.lastPulseKey = props.pulse.key;
    const n = props.nodeMap[props.pulse.id];
    if (n) st.current.pulses.push({ x: n.x, y: n.y, r: KIND_R[n.kind] || 8, t0: performance.now(), big: n.kind === 'keystone' || n.kind === 'core' || n.kind === 'notable' });
  }

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const s = st.current;
    let raf = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      s.dpr = window.devicePixelRatio || 1;
      s.w = Math.max(1, r.width);
      s.h = Math.max(1, r.height);
      canvas.width = Math.round(s.w * s.dpr);
      canvas.height = Math.round(s.h * s.dpr);
      s.fitZ = Math.min(s.w, s.h) / (2 * propsRef.current.fitRadius);
      if (!s.inited) {
        s.inited = true;
        s.z = propsRef.current.phase === 'done' ? s.fitZ : s.fitZ * 2.6;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (propsRef.current.phase !== 'done') return;
      const rect = canvas.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * s.w;
      const my = ((e.clientY - rect.top) / rect.height) * s.h;
      const z2 = Math.min(s.fitZ * 9, Math.max(s.fitZ * 0.8, s.z * (e.deltaY < 0 ? 1.16 : 0.86)));
      // keep the world point under the cursor fixed
      s.camX = s.camX + (mx - s.w / 2) / s.z - (mx - s.w / 2) / z2;
      s.camY = s.camY + (my - s.h / 2) / s.z - (my - s.h / 2) / z2;
      s.z = z2;
      if (s.hover) { s.hover = null; propsRef.current.onHoverNode(null, 0, 0); }
    };
    canvas.addEventListener('wheel', wheel, { passive: false });

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const p = propsRef.current;
      const g = geomRef.current;
      const pal = PALETTES[p.variant];
      const { w, h, dpr } = s;
      if (canvas.width === 0) return;

      // reveal camera: pull back from the lone star to the whole web
      if (p.phase === 'expanding') {
        const t = clamp01((now - s.revealT0) / 2900);
        s.z = s.revealFrom + (s.fitZ - s.revealFrom) * easeInOut(t);
        s.camX = s.camX * (1 - t * 0.12);
        s.camY = s.camY * (1 - t * 0.12);
        if (!s.revealDone && now - s.revealT0 > 3300) {
          s.revealDone = true;
          p.onRevealDone && p.onRevealDone();
        }
      } else if (p.phase === 'seed') {
        s.z = s.fitZ * 2.6;
        s.camX = 0; s.camY = 0;
      }

      const z = s.z;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 - s.camX * z), dpr * (h / 2 - s.camY * z));

      // view bounds (world coords) for culling
      const pad = 160;
      const vx0 = s.camX - w / 2 / z - pad, vx1 = s.camX + w / 2 / z + pad;
      const vy0 = s.camY - h / 2 / z - pad, vy1 = s.camY + h / 2 / z + pad;
      const inView = (x: number, y: number) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

      const seed = p.phase === 'seed';
      const expanding = p.phase === 'expanding';
      const revealK = 2100 / (g.maxDist || 1);
      const revealA = (dist: number) => (expanding ? clamp01((now - s.revealT0 - 120 - dist * revealK) / 550) : 1);

      // ---- edges
      if (!seed) {
        const lw = Math.max(1.7 / z, 1.05);
        if (expanding) {
          // per-edge alpha while the web ignites outward
          for (const e of g.eg) {
            const a = revealA(e.dist);
            if (a <= 0) continue;
            const lit = p.owned.has(e.a) && p.owned.has(e.b);
            ctx.globalAlpha = a;
            ctx.strokeStyle = lit ? pal.edgeLit : pal.edge;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(e.ax, e.ay);
            ctx.lineTo(e.bx, e.by);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else {
          // three batched passes: dim, half-lit, lit
          for (let pass = 0; pass < 3; pass++) {
            ctx.strokeStyle = pass === 0 ? pal.edge : pass === 1 ? pal.edgeHalf : pal.edgeLit;
            ctx.lineWidth = pass === 2 ? lw * 1.3 : lw;
            ctx.beginPath();
            let any = false;
            for (const e of g.eg) {
              if (!inView(e.ax, e.ay) && !inView(e.bx, e.by)) continue;
              const oa = p.owned.has(e.a), ob = p.owned.has(e.b);
              const cls = oa && ob ? 2 : oa || ob ? 1 : 0;
              if (cls !== pass) continue;
              any = true;
              ctx.moveTo(e.ax, e.ay);
              ctx.lineTo(e.bx, e.by);
            }
            if (any) ctx.stroke();
          }
        }
      }

      // ---- nodes
      const iconLOD = z > 1.0 ? 2 : z > 0.62 ? 1 : 0; // 0 none, 1 big nodes, 2 all
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < p.nodes.length; i++) {
        const n = p.nodes[i];
        const isCore = n.kind === 'core';
        if (seed && !isCore) continue;
        if (!inView(n.x, n.y)) continue;
        const a = isCore ? 1 : revealA(g.nDist[i]);
        if (a <= 0) continue;
        const owned = p.owned.has(n.id);
        const buy = p.allocatable.has(n.id);
        const reach = !owned && !buy && p.reachable.has(n.id);
        const hovered = s.hover === n.id;
        let r = KIND_R[n.kind] || 8;
        if (expanding && !isCore) r *= 1 + 0.5 * (1 - a); // settle-in pop
        ctx.globalAlpha = a;

        // halos (cached sprites, cheap to blit)
        if (isCore && (seed || p.coreHot)) {
          const breathe = 0.35 + 0.22 * Math.sin(now / (seed ? 420 : 620));
          ctx.globalAlpha = a * breathe;
          const gr = r * (seed ? 4.4 : 3.6);
          ctx.drawImage(glowSprite(seed ? pal.glowCore : pal.glowBuy), n.x - gr, n.y - gr, gr * 2, gr * 2);
          ctx.globalAlpha = a;
        } else if (buy) {
          const shimmer = 0.16 + 0.09 * Math.sin(now / 520 + i * 1.7);
          ctx.globalAlpha = a * shimmer;
          ctx.drawImage(glowSprite(pal.glowBuy), n.x - r * 2.4, n.y - r * 2.4, r * 4.8, r * 4.8);
          ctx.globalAlpha = a;
        } else if (owned && n.kind !== 'small') {
          ctx.globalAlpha = a * 0.22;
          ctx.drawImage(glowSprite(pal.glowOwned), n.x - r * 2.6, n.y - r * 2.6, r * 5.2, r * 5.2);
          ctx.globalAlpha = a;
        }
        if (hovered && (buy || (owned && p.removable.has(n.id)) || (isCore && !seed))) {
          ctx.globalAlpha = a * 0.5;
          const gc = owned && !isCore ? pal.glowRefund : pal.glowBuy;
          ctx.drawImage(glowSprite(gc), n.x - r * 2.8, n.y - r * 2.8, r * 5.6, r * 5.6);
          ctx.globalAlpha = a;
        }

        // body
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isCore ? pal.coreFill
          : n.kind === 'keystone' ? (owned ? pal.bodyKeystoneOwned : pal.bodyKeystone)
          : owned ? pal.bodyOwned : pal.body;
        ctx.fill();
        ctx.strokeStyle = isCore ? pal.coreStroke
          : hovered && owned && p.removable.has(n.id) ? pal.glowRefund
          : owned ? pal.strokeOwned
          : buy ? pal.strokeBuy
          : hovered ? pal.strokeHover
          : reach ? pal.strokeReach : pal.stroke;
        ctx.lineWidth = (isCore ? 2.5 : n.kind === 'keystone' ? 2.2 : n.kind === 'notable' ? 2 : 1.5) * (hovered ? 1.35 : 1);
        if (!owned && !buy && !reach && !isCore) ctx.globalAlpha = a * 0.8;
        ctx.stroke();
        ctx.globalAlpha = a;

        if (n.kind === 'keystone') {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 0.72, 0, Math.PI * 2);
          ctx.strokeStyle = owned ? '#ffffff' : pal.stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // icon (zoom-gated: unreadable specks are just noise)
        if (iconLOD === 2 || (iconLOD === 1 && (n.kind !== 'small' || buy)) || isCore) {
          const iconCol = owned ? pal.iconOwned : buy ? pal.iconBuy : reach ? pal.icon : pal.iconLocked;
          const sid = nodeSpellIconId(n);
          if (sid) {
            const size = r * 1.55;
            ctx.save();
            ctx.translate(n.x - size / 2, n.y - size / 2);
            ctx.scale(size / 24, size / 24);
            ctx.lineWidth = 1.9;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = iconCol;
            ctx.fillStyle = iconCol;
            const ip = iconPaths(sid);
            for (const path of ip.strokes) ctx.stroke(path);
            for (const path of ip.fills) ctx.fill(path);
            ctx.restore();
          } else {
            const glyph = nodeIcon(n);
            if (glyph) {
              ctx.fillStyle = iconCol;
              ctx.font = `${KIND_ICON[n.kind] || 9}px 'Roboto', 'Segoe UI Symbol', sans-serif`;
              ctx.fillText(glyph, n.x, n.y + 0.5);
            }
          }
        }
        ctx.globalAlpha = 1;
      }

      // ---- allocation pulses
      for (let k = s.pulses.length - 1; k >= 0; k--) {
        const pu = s.pulses[k];
        const t = (now - pu.t0) / 620;
        if (t >= 1) { s.pulses.splice(k, 1); continue; }
        const e = easeOut(t);
        ctx.beginPath();
        ctx.arc(pu.x, pu.y, pu.r * (0.7 + e * (pu.big ? 3.6 : 2.4)), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${pal.pulse},${(1 - t) * 0.9})`;
        ctx.lineWidth = Math.max(2 / z, 1.4) * (1 - t * 0.6);
        ctx.stroke();
      }

      // ---- reveal shockwaves
      if (expanding) {
        for (let wv = 0; wv < 2; wv++) {
          const t = clamp01((now - s.revealT0 - wv * 300) / 2700);
          if (t <= 0 || t >= 1) continue;
          ctx.beginPath();
          ctx.arc(0, 0, 30 + easeOut(t) * g.maxDist * 1.12, 0, Math.PI * 2);
          ctx.strokeStyle = `${wv === 0 ? pal.wave1 : pal.wave2}${(1 - t) * 0.85})`;
          ctx.lineWidth = (wv === 0 ? 2.2 : 1.6) / z;
          ctx.stroke();
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('wheel', wheel);
    };
  }, []);

  // ---------------------------------------------------------- interaction
  const toWorld = (e: React.MouseEvent) => {
    const s = st.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * s.w;
    const my = ((e.clientY - rect.top) / rect.height) * s.h;
    return { wx: (mx - s.w / 2) / s.z + s.camX, wy: (my - s.h / 2) / s.z + s.camY };
  };

  const hitTest = (wx: number, wy: number): TreeNode | null => {
    const p = propsRef.current;
    const s = st.current;
    let best: TreeNode | null = null;
    let bestD = Infinity;
    for (const n of p.nodes) {
      if (p.phase === 'seed' && n.kind !== 'core') continue;
      const r = Math.max((KIND_R[n.kind] || 8) + 4, 13 / s.z);
      const dd = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (dd < r * r && dd < bestD) { bestD = dd; best = n; }
    }
    return best;
  };

  const nodeScreenPos = (n: TreeNode) => {
    const s = st.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = rect.left + (((n.x - s.camX) * s.z + s.w / 2) / s.w) * rect.width;
    const sy = rect.top + (((n.y - (KIND_R[n.kind] || 8) - s.camY) * s.z + s.h / 2) / s.h) * rect.height;
    return { sx, sy };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (propsRef.current.phase !== 'done') return;
    const s = st.current;
    s.dragging = true;
    s.dragMoved = false;
    s.sx = e.clientX; s.sy = e.clientY;
    s.ox = s.camX; s.oy = s.camY;
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const s = st.current;
    const p = propsRef.current;
    if (s.dragging) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
      if (Math.abs(dx) + Math.abs(dy) > 5) {
        if (!s.dragMoved && s.hover) { s.hover = null; p.onHoverNode(null, 0, 0); }
        s.dragMoved = true;
      }
      if (s.dragMoved) {
        const k = s.w / rect.width;
        s.camX = s.ox - (dx * k) / s.z;
        s.camY = s.oy - (dy * k) / s.z;
        canvasRef.current!.style.cursor = 'var(--cursor-grabbing, grabbing)';
      }
      return;
    }
    if (p.phase === 'expanding') return;
    const { wx, wy } = toWorld(e);
    const n = hitTest(wx, wy);
    const id = n ? n.id : null;
    if (id !== s.hover) {
      s.hover = id;
      if (n) {
        const { sx, sy } = nodeScreenPos(n);
        p.onHoverNode(n.id, sx, sy);
      } else {
        p.onHoverNode(null, 0, 0);
      }
    }
    const clickable = n && (n.kind === 'core' || p.allocatable.has(n.id) || (p.owned.has(n.id) && p.removable.has(n.id)));
    canvasRef.current!.style.cursor = clickable ? 'var(--cursor-point, pointer)' : 'var(--cursor-grab, grab)';
  };

  const endDrag = (e: React.MouseEvent) => {
    const s = st.current;
    const wasDrag = s.dragging && s.dragMoved;
    s.dragging = false;
    canvasRef.current!.style.cursor = 'var(--cursor-grab, grab)';
    if (wasDrag) return;
    if (propsRef.current.phase === 'expanding') return;
    const { wx, wy } = toWorld(e);
    const n = hitTest(wx, wy);
    if (n) propsRef.current.onNodeClick(n.id);
  };

  const onLeave = () => {
    const s = st.current;
    s.dragging = false;
    if (s.hover) { s.hover = null; propsRef.current.onHoverNode(null, 0, 0); }
  };

  return (
    <canvas
      ref={canvasRef}
      className="tree-canvas"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={onLeave}
    />
  );
}
