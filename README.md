# Dreamtide: Reverie of the Last Magus

A bullet-heaven survivors-like set inside a dying dream. You are the last magus;
your spells cast themselves. Weave through the horde, harvest the essence of the
fallen, and grow from a single ember into a storm of light before the tide
swallows the dream.

Built from scratch in TypeScript and rendered entirely on **WebGPU** — every
star, spell and nightmare is drawn procedurally, with no art assets on disk.

```sh
npm install
npm run dev        # dev server → http://localhost:5173
npm run build      # typecheck + production build
```

> Requires a browser with WebGPU (current Chrome, Edge, or the desktop build).

---

## The dream

- **You move; the magic answers.** Steer with **WASD** or the arrow keys and
  keep breathing room — you never aim a spell. Each one you carry fires on its
  own rhythm, so survival is all positioning, timing and the loadout you build.
- **22 spells, each its own language.** Emberfall, Rimeheart, Stormcall, Void
  Rift, Moonlance, Dream Serpent, Sleepless Eye, Nightmare Brand and more —
  every school has a distinct colour, motion, sound and particle voice. Raise
  one to mastery and choose its **evolution** for a transcendent form.
- **Build a run on the fly.** Level up to pick new spells, boons and generic
  amplifiers. Fell a boss and claim a run-defining **relic**. Kneel at a
  Whispering Altar and take a **pact** — a boon braided to a curse.
- **Elemental resonance.** Every hit marks its target; marks react with one
  another for chained bursts once you learn to layer your elements.
- **A horde that pushes back.** Wisps, bats, gazing eyes, blinking shades,
  colossal golems, singing sirens and warlocks — culminating in bosses with
  their own choreographed attack patterns that enrage the longer they live.
- **A constellation between runs.** Spend the stardust you earn on a sprawling
  skill web of eight schools plus a hidden dark path — persistent power that
  carries into every new dream.

## Controls

| Key | Action |
| --- | --- |
| **WASD** / **Arrows** | Move |
| **1–4** | Choose a card on level-up |
| **Esc** | Pause / settings |
| **F** | Toggle the performance overlay |

## Settings

Tune audio, four performance presets (particles, damage numbers, health bars,
render resolution) and **HDR**. When your display and OS report HDR support, the
HDR toggle lets bright spells bloom past white into your monitor's headroom;
it's detected automatically and greyed out otherwise. Everything persists
locally and applies live.

## Desktop build

A native desktop app ships via [Tauri](https://tauri.app/) (borderless
fullscreen, **F11** for true exclusive fullscreen):

```sh
npm run tauri:dev     # run the desktop app in dev
npm run tauri:build   # build a native installer
```

---

## Under the hood

Dreamtide is engineered to stay smooth when the screen is a wall of bodies,
bullets and light. The interesting bits:

- **Fixed-timestep simulation (60 Hz) with interpolated rendering.** The sim is
  deterministic and stable under frame spikes; rendering runs at display refresh
  and draws every moving entity at a position interpolated between the last two
  sim steps.
- **Zero steady-state allocation.** Enemies, projectiles, boss bullets, zones,
  beams, bolts, gems and damage texts live in free-list pools with swap-remove
  compaction — no per-frame `.filter()`, no object churn in the hot path.
- **Stamp-mask hit tracking.** Per-cast hit sets are replaced by rented
  `Uint32Array` masks keyed by enemy slot; a globally unique stamp per effect
  means the arrays never need clearing.
- **One spatial grid for everything.** A single uniform grid rebuild per sim
  step routes every proximity query — zone ticks, beams, orbitals and
  projectile hit tests alike.
- **WebGPU-only scene renderer.** The whole world draws on one canvas in a
  handful of entity-count-independent draw calls:
  1. **background** — a fully procedural dreamscape shader (domain-warped
     nebula, aurora veils, three parallax star fields, drifting colour motes);
  2. **shapes** — spell zones, beams and lightning as instanced analytic SDF
     primitives (rings, discs, spirals, capsules), crisp at any radius;
  3. **sprites** — every entity and particle as one instanced quad from a baked
     procedural atlas, drawn in a single painter's-order pass where additive and
     source-over blending coexist in one pipeline;
  4. **post** — HDR (`rgba16float`) scene → threshold bloom mip-chain → filmic
     composite with vignette and dither, presented in SDR or true HDR.
  A thin full-resolution 2D overlay carries damage text, health bars, banners
  and the perf HUD.
- **Procedural everything.** Sprites are painted once with vector code at
  supersampled resolution and packed into a texture atlas; music and every sound
  effect are synthesised live via the Web Audio API, with adaptive scoring that
  swells and darkens with the danger on screen.
- **Built-in profiler.** Press **F** to show render FPS, 1% low FPS, simulation
  FPS, per-subsystem frame timings and live entity counts. Hide it again and a
  diagnostic JSON naming the observed bottleneck is downloaded and logged.

**Stack:** TypeScript · WebGPU · Web Audio · React (menus/HUD only) · Vite ·
Tauri (desktop). No game engine, no rendering library, no art or audio assets.

## Save compatibility

Constellation progress is stored under `dreamtide_meta_v4`. Older
`dreamtide_meta_v3` saves (the fixed-price tree) migrate automatically on first
load: every coin ever spent is refunded in full, both webs stay revealed, and
points become the new currency for stars.
