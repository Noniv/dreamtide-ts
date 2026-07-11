# Dreamtide (TypeScript rewrite)

A ground-up architectural rewrite of Dreamtide — same game, same balance —
rebuilt for heavy endgame scenarios, rendered entirely on WebGPU.

```sh
npm install
npm run dev        # dev server
npm run build      # typecheck + production build
```

## Architecture

- **Fixed-timestep simulation (60 Hz) with interpolated rendering** — the sim
  is deterministic and stable under frame spikes; rendering runs at display
  refresh, drawing every moving entity at a position interpolated between the
  last two sim steps (`engine.ts` accumulator loop, `render.ts` `lerp`).
- **Pooled entities, zero steady-state allocation** — enemies, projectiles,
  boss bullets, zones, beams, bolts, gems and damage texts live in free-list
  pools with swap-remove compaction (`world.ts`). No `.filter()` per frame,
  no object literals in the hot path.
- **Stamp-mask hit tracking** — the per-cast `new Set()`s of the original are
  replaced with rented `Uint32Array` masks keyed by enemy slot; a globally
  unique stamp per effect means the arrays never need clearing.
- **Spatial grid everywhere** — one uniform grid rebuild per sim step; all
  proximity queries (zone ticks, beams, orbitals, *and* projectile hit tests)
  route through it.
- **WebGPU-only scene renderer** (`worldGPU.ts`) — the entire world draws on
  one canvas in a handful of entity-count-independent draw calls:
  1. *background*: fully procedural dreamscape shader (domain-warped nebula,
     aurora veils, three parallax star fields, drifting colour motes);
  2. *shapes*: spell zones, beams and lightning as instanced analytic SDF
     primitives (rings, discs, spirals, capsules) — crisp at any radius;
  3. *sprites*: every entity and particle as one instanced quad from a baked
     procedural atlas (`enemySprites.ts`), drawn in a single pass in painter's
     order — premultiplied output where additive quads write zero alpha, so
     "lighter" and "source-over" blending coexist in one pipeline;
  4. *post*: HDR (rgba16float) scene → threshold bloom mip-chain → filmic
     composite with vignette and dither.
  A thin full-resolution 2D overlay canvas on top carries damage text, health
  bars, banners and the perf HUD. There is no Canvas2D/WebGL world fallback —
  WebGPU is required (Tauri/WebView2 and all modern desktop browsers have it).
- **Performance overlay** — press **F** to show render FPS, 1% low FPS,
  simulation FPS, per-subsystem frame timings and live entity counts. Press
  **F** again to hide it: a minimal diagnostic JSON naming the observed
  bottleneck is downloaded and logged to the console.

## Save compatibility

Constellation progress is stored under `dreamtide_meta_v4`. Older
`dreamtide_meta_v3` saves (the fixed-price tree) migrate automatically on
first load: every coin ever spent on nodes is refunded in full, both webs
stay revealed, and nothing remains allocated — points are the new currency
for stars.
