# Dreamtide (TypeScript rewrite)

A ground-up architectural rewrite of Dreamtide — same game, same balance, same
visuals — rebuilt for heavy endgame scenarios.

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
- **GPU particle layer** — glow/smoke particles (the #1 measured frame cost)
  render as a single instanced draw call. Backend order: **WebGPU → WebGL2 →
  Canvas2D fallback** (`gpuParticles.ts`). Vector particle modes and the
  procedurally-animated entities stay on Canvas2D: entity counts are capped
  (~420) and view-culled, and their hand-animated vector look doesn't survive
  sprite-atlas baking.
- **Performance overlay** — press **F** to show render FPS, 1% low FPS,
  simulation FPS, per-subsystem frame timings and live entity counts. Press
  **F** again to hide it: a minimal diagnostic JSON naming the observed
  bottleneck is downloaded and logged to the console.

## Save compatibility

Constellation progress is stored under the same localStorage key
(`dreamtide_meta_v3`) as the original, so existing saves carry over when
served from the same origin.
