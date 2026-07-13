---
name: verify
description: Build, launch, and visually verify dreamtide-ts changes in a real browser (WebGPU works headless).
---

# Verifying dreamtide-ts changes

Vite + React + WebGPU game. No test suite — verification is visual, in a running browser.

## Launch

```powershell
npm run dev          # vite on http://localhost:5173/ (run in background)
```

Surfaces:
- `http://localhost:5173/` — the game. Menu → click the **"Fall asleep"** button to start a run.
- `http://localhost:5173/enemy-viewer.html` — dev page with every enemy's baked sprite frames animating (Canvas2D, no WebGPU needed). Fastest check for sprite/atlas changes.

## Headless Chrome works, including WebGPU

Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`. WebGPU initializes headless on this machine (nvidia adapter) with:

```
--headless=new --no-first-run --user-data-dir=<temp profile> --enable-unsafe-webgpu --enable-gpu
```

- A fresh `--user-data-dir` is REQUIRED or the screenshot silently never writes (profile lock with the user's running Chrome).
- Static pages: one-shot `--screenshot=out.png --virtual-time-budget=6000 <url>`.
- Interactive flows (clicking the menu, in-game screenshots): drive via CDP — launch with `--remote-debugging-port=<port>`, discover the page over `http://127.0.0.1:<port>/json`, connect with Node's global WebSocket, use `Runtime.evaluate` + `Page.captureScreenshot` (supports `clip` with `scale` for close-ups). The player idles near screen centre of a 1280x800 window (~x 560–740, y 280–440).

## Reaching module internals at runtime

Vite dev serves source modules as ESM: `await import('/src/game/enemySprites.ts')` from page context returns the SAME live module instance the game uses. Good for exercising exported APIs that have no UI yet (e.g. `setWizardSkin`).

## Gotchas

- Capture `Runtime.exceptionThrown` / console errors during CDP runs — WebGPU failures are often silent black canvases otherwise.
- The sprite atlas is baked once at engine start (`prebakeSprites`); atlas changes need a page reload, except in-place repaints that bump `atlas.version` (picked up next frame).
