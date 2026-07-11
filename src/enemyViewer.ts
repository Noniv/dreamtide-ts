// Standalone dev page: renders every enemy's baked sprite frames as animated,
// labeled cards. Open at /enemy-viewer.html with the normal dev server.
import {
  buildAtlas, enemyFrameId, ENEMY_KINDS, FRAMES, type Atlas,
} from './game/enemySprites';

const NAMES: Record<string, string> = {
  wisp: 'Wisp',
  bat: 'Bat',
  eye: 'Eye',
  shade: 'Shade',
  golem: 'Golem',
  siren: 'Siren',
  warlock: 'Warlock',
};

const CANVAS = 160;   // card canvas size in px
const SCALE = 2.2;    // world-units → px magnification
const FPS = 12;       // baked-loop playback speed

document.body.style.cssText =
  'margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% 30%,#1c1440,#0a0618 70%);' +
  'font-family:Georgia,serif;color:#cfd0ee;display:flex;flex-direction:column;align-items:center';

const title = document.createElement('h1');
title.textContent = 'Dreamtide — Enemies';
title.style.cssText = 'font-weight:normal;letter-spacing:0.2em;color:#e6d1ff;margin:28px 0 4px';
document.body.appendChild(title);

const hint = document.createElement('div');
hint.textContent = `${ENEMY_KINDS.length} kinds · ${FRAMES} baked frames each`;
hint.style.cssText = 'opacity:0.55;font-size:13px;margin-bottom:24px';
document.body.appendChild(hint);

const grid = document.createElement('div');
grid.style.cssText =
  'display:flex;flex-wrap:wrap;justify-content:center;gap:20px;max-width:1000px;padding:0 20px 40px';
document.body.appendChild(grid);

interface Card { type: string; ctx: CanvasRenderingContext2D }
const cards: Card[] = [];

for (const type of ENEMY_KINDS) {
  const card = document.createElement('div');
  card.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 20px;' +
    'border:1px solid rgba(154,140,255,0.25);border-radius:12px;background:rgba(20,12,48,0.5)';

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CANVAS;
  card.appendChild(canvas);

  const label = document.createElement('div');
  label.textContent = NAMES[type] ?? type;
  label.style.cssText = 'font-size:17px;letter-spacing:0.12em;color:#e6d1ff';
  card.appendChild(label);

  grid.appendChild(card);
  cards.push({ type, ctx: canvas.getContext('2d')! });
}

function drawSprite(ctx: CanvasRenderingContext2D, atlas: Atlas, id: string, rot = 0) {
  const e = atlas.entries.get(id);
  if (!e) return;
  const px = e.half * 2 * SCALE;
  ctx.save();
  ctx.translate(CANVAS / 2, CANVAS / 2);
  ctx.rotate(rot);
  ctx.drawImage(
    atlas.canvas,
    e.u0 * atlas.size, e.v0 * atlas.size,
    (e.u1 - e.u0) * atlas.size, (e.v1 - e.v0) * atlas.size,
    -px / 2, -px / 2, px, px,
  );
  ctx.restore();
}

const atlas = buildAtlas();

function tick(now: number) {
  const t = now / 1000;
  const frame = Math.floor(t * FPS) % FRAMES;
  for (const c of cards) {
    c.ctx.clearRect(0, 0, CANVAS, CANVAS);
    if (c.type === 'eye') {
      // eye bakes body only; crown + iris are live quads in-game — mirror that
      drawSprite(c.ctx, atlas, enemyFrameId(c.type, frame));
      drawSprite(c.ctx, atlas, 'tentacles', t * 0.4);
      drawSprite(c.ctx, atlas, 'iris', t * 0.9);
    } else {
      drawSprite(c.ctx, atlas, enemyFrameId(c.type, frame));
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
