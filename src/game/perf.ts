// Performance monitor. Toggled with F: shows render FPS, 1% low FPS, and
// simulation FPS plus per-subsystem timings and live entity counts. When the
// overlay is hidden again it exports a minimal diagnostic JSON naming the
// bottleneck observed while it was open.
//
// Important reading note: sim/render/particle times are CPU-side JS costs.
// Canvas2D work rasterizes later on the browser's GPU/compositor side, so the
// gap between avgFrameMs and the summed JS costs ("other") is GPU raster +
// compositing + vsync quantization — that gap is what the diagnosis inspects.

export interface PerfCounts {
  enemies: number;
  projectiles: number;
  particles: number;
  zones: number;
  gems: number;
  texts: number;
}

const WINDOW = 240;  // frames used for the live readout (~4s at 60fps)
const LOW_WINDOW = 600; // frames used for the 1% low

const COMMON_HZ = [60, 75, 90, 120, 144, 165, 180, 240, 360];

// Per-frame draw-op tally the renderer bumps and the monitor snapshots. Used
// to prove the enemy-sprite change: `enemyBlits` is one drawImage per enemy
// now (was ~40 path ops each), `enemyLiveOps` counts the live overlays kept
// (iris, coronas, boss crown, caster charge). Reset by the renderer each frame.
export const drawStats = { enemyBlits: 0, enemyLiveOps: 0, worldQuads: 0, worldDrawCalls: 0 };

class Ring {
  buf: Float32Array;
  n = 0;
  idx = 0;
  constructor(size: number) { this.buf = new Float32Array(size); }
  push(v: number) {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }
  avg(lastN = this.n): number {
    const count = Math.min(lastN, this.n);
    if (!count) return 0;
    let s = 0;
    for (let i = 0; i < count; i++) s += this.buf[(this.idx - 1 - i + this.buf.length * 2) % this.buf.length];
    return s / count;
  }
  max(lastN = this.n): number {
    const count = Math.min(lastN, this.n);
    let m = 0;
    for (let i = 0; i < count; i++) m = Math.max(m, this.buf[(this.idx - 1 - i + this.buf.length * 2) % this.buf.length]);
    return m;
  }
  percentile(p: number, lastN = this.n): number {
    const count = Math.min(lastN, this.n);
    if (!count) return 0;
    const tmp: number[] = new Array(count);
    for (let i = 0; i < count; i++) tmp[i] = this.buf[(this.idx - 1 - i + this.buf.length * 2) % this.buf.length];
    tmp.sort((a, b) => a - b);
    return tmp[Math.min(count - 1, Math.floor(p * count))];
  }
  // fraction of the last `lastN` samples that are <= limit
  fracBelow(limit: number, lastN = this.n): number {
    const count = Math.min(lastN, this.n);
    if (!count) return 0;
    let s = 0;
    for (let i = 0; i < count; i++) {
      if (this.buf[(this.idx - 1 - i + this.buf.length * 2) % this.buf.length] <= limit) s++;
    }
    return s / count;
  }
}

export class PerfMonitor {
  visible = false;
  private frameMs = new Ring(LOW_WINDOW);   // full rAF-to-rAF delta
  private simMs = new Ring(WINDOW);         // total sim step time this frame
  private renderMs = new Ring(WINDOW);      // world render time this frame
  private particleMs = new Ring(WINDOW);    // particle update+draw time
  private simSteps = new Ring(WINDOW);      // fixed steps executed this frame
  private counts: PerfCounts = { enemies: 0, projectiles: 0, particles: 0, zones: 0, gems: 0, texts: 0 };
  private peakCounts: PerfCounts = { enemies: 0, projectiles: 0, particles: 0, zones: 0, gems: 0, texts: 0 };
  private sessionStart = 0;
  gpuBackend = 'canvas2d';
  // environment facts, set by the engine (resize / gpu attach)
  dpr = 1;
  renderScale = 1;
  viewW = 0;
  viewH = 0;
  layers = 1; // stacked full-screen canvases being composited
  private enemyBlits = new Ring(WINDOW);
  private enemyLiveOps = new Ring(WINDOW);
  private worldQuads = new Ring(WINDOW);
  private worldDrawCalls = new Ring(WINDOW);

  toggle(): boolean {
    this.visible = !this.visible;
    if (this.visible) {
      this.sessionStart = performance.now();
      this.peakCounts = { enemies: 0, projectiles: 0, particles: 0, zones: 0, gems: 0, texts: 0 };
    } else {
      this.exportLog();
    }
    return this.visible;
  }

  record(frameMs: number, simMs: number, simSteps: number, renderMs: number, particleMs: number, counts: PerfCounts) {
    this.frameMs.push(frameMs);
    this.simMs.push(simMs);
    this.renderMs.push(renderMs);
    this.particleMs.push(particleMs);
    this.simSteps.push(simSteps);
    this.enemyBlits.push(drawStats.enemyBlits);
    this.enemyLiveOps.push(drawStats.enemyLiveOps);
    this.worldQuads.push(drawStats.worldQuads);
    this.worldDrawCalls.push(drawStats.worldDrawCalls);
    this.counts = counts;
    if (this.visible) {
      const pk = this.peakCounts;
      pk.enemies = Math.max(pk.enemies, counts.enemies);
      pk.projectiles = Math.max(pk.projectiles, counts.projectiles);
      pk.particles = Math.max(pk.particles, counts.particles);
      pk.zones = Math.max(pk.zones, counts.zones);
      pk.gems = Math.max(pk.gems, counts.gems);
      pk.texts = Math.max(pk.texts, counts.texts);
    }
  }

  fps(): number { const a = this.frameMs.avg(WINDOW); return a > 0 ? 1000 / a : 0; }
  low1(): number { const p = this.frameMs.percentile(0.99, LOW_WINDOW); return p > 0 ? 1000 / p : 0; }
  simFps(): number {
    const stepsPerFrame = this.simSteps.avg(WINDOW);
    const f = this.fps();
    return Math.min(60, stepsPerFrame * f);
  }

  // Estimate the display refresh rate from the fastest frames observed: when
  // the pipeline has headroom, deltas bottom out at the vsync interval. The
  // 3rd-percentile delta is snapped to the nearest common rate.
  displayHz(): number {
    const p = this.frameMs.percentile(0.03, LOW_WINDOW);
    if (p <= 0) return 0;
    const raw = 1000 / p;
    let best = 0, bestErr = Infinity;
    for (const hz of COMMON_HZ) {
      const err = Math.abs(raw - hz) / hz;
      if (err < bestErr) { bestErr = err; best = hz; }
    }
    return bestErr < 0.12 ? best : Math.round(raw);
  }

  private diagnose() {
    const avgFrame = this.frameMs.avg(WINDOW);
    const avgSim = this.simMs.avg(WINDOW);
    const avgRender = this.renderMs.avg(WINDOW);
    const avgParticle = this.particleMs.avg(WINDOW);
    const worst = this.frameMs.max(LOW_WINDOW);
    const jsMs = avgSim + avgRender + avgParticle;
    const other = Math.max(0, avgFrame - jsMs);
    const hz = this.displayHz();
    const vsync = hz > 0 ? 1000 / hz : 0;
    // share of frames landing inside 1 / 2 / 3+ vsync intervals
    const hit1 = vsync ? this.frameMs.fracBelow(vsync * 1.5, LOW_WINDOW) : 0;
    const hit2 = vsync ? this.frameMs.fracBelow(vsync * 2.5, LOW_WINDOW) : 0;

    let bottleneck: string;
    if (avgFrame >= 17) {
      const parts: [string, number][] = [
        ['simulation (update loop: AI, movement, collision)', avgSim],
        ['world rendering JS (Canvas2D entity draws)', avgRender],
        ['particles (update + draw/dispatch)', avgParticle],
        ['GPU raster + compositor + GC ("other": frame minus measured JS)', other],
      ];
      parts.sort((a, b) => b[1] - a[1]);
      bottleneck = `${parts[0][0]} at ${parts[0][1].toFixed(2)}ms of a ${avgFrame.toFixed(2)}ms frame`;
      if (parts[0][0].startsWith('world') && this.peakCounts.enemies > 250) {
        bottleneck += ` — enemy draw count peaked at ${this.peakCounts.enemies}`;
      }
      if (parts[0][0].startsWith('particles') && this.gpuBackend === 'canvas2d') {
        bottleneck += ' — no GPU backend available; particles are on the Canvas2D fallback';
      }
      if (parts[0][0].startsWith('GPU raster')) {
        bottleneck += ` — Canvas2D effects rasterize browser-side at ${this.viewW}×${this.viewH}@${this.dpr}x across ${this.layers} composited layers; JS itself only uses ${jsMs.toFixed(2)}ms`;
      }
    } else if (hz >= 80 && this.fps() < hz * 0.9 && other > jsMs * 2) {
      bottleneck = `GPU/compositor-bound below the display's ${hz}Hz: JS work is only ${jsMs.toFixed(2)}ms but frames average ${avgFrame.toFixed(2)}ms — the ${other.toFixed(2)}ms gap is browser-side Canvas2D rasterization + compositing of ${this.layers} stacked ${this.viewW}×${this.viewH}@${this.dpr}x layers, so ${(100 * (1 - hit1)).toFixed(0)}% of frames miss the ${vsync.toFixed(1)}ms vsync window`;
    } else {
      bottleneck = 'none — frame budget comfortably met (avg ' + avgFrame.toFixed(2) + 'ms)';
    }

    return {
      capturedAt: new Date().toISOString(),
      overlayOpenMs: Math.round(performance.now() - this.sessionStart),
      gpuBackend: this.gpuBackend,
      display: { estimatedHz: hz, vsyncMs: +vsync.toFixed(2), canvas: `${this.viewW}x${this.viewH}`, dpr: this.dpr, renderScale: this.renderScale, worldRaster: `${Math.round(this.viewW * this.dpr * this.renderScale)}x${Math.round(this.viewH * this.dpr * this.renderScale)}`, compositedLayers: this.layers },
      fps: +this.fps().toFixed(1),
      low1PercentFps: +this.low1().toFixed(1),
      simFps: +this.simFps().toFixed(1),
      avgFrameMs: +avgFrame.toFixed(3),
      worstFrameMs: +worst.toFixed(3),
      avgSimMs: +avgSim.toFixed(3),
      avgRenderMs: +avgRender.toFixed(3),
      avgParticleMs: +avgParticle.toFixed(3),
      avgJsMs: +jsMs.toFixed(3),
      avgOtherMs: +other.toFixed(3),
      vsyncBuckets: hz > 0 ? {
        hitFirstVsyncPct: +(hit1 * 100).toFixed(1),
        oneMissedPct: +((hit2 - hit1) * 100).toFixed(1),
        twoPlusMissedPct: +((1 - hit2) * 100).toFixed(1),
      } : null,
      counts: { ...this.counts },
      peakCounts: { ...this.peakCounts },
      enemyDraw: {
        blitsPerFrame: +this.enemyBlits.avg(WINDOW).toFixed(1),
        liveOverlayOpsPerFrame: +this.enemyLiveOps.avg(WINDOW).toFixed(1),
      },
      worldGPU: {
        instancedQuadsPerFrame: +this.worldQuads.avg(WINDOW).toFixed(0),
        drawCallsPerFrame: +this.worldDrawCalls.avg(WINDOW).toFixed(1),
        note: 'entire entity world (enemies+gems+projectiles+particles) in this many WebGPU draws',
      },
      bottleneck,
    };
  }

  exportLog() {
    const diag = this.diagnose();
    console.info('[perf] diagnostic:', diag);
    try {
      const blob = new Blob([JSON.stringify(diag, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dreamtide-perf-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { /* headless/test environment */ }
  }

  draw(ctx: CanvasRenderingContext2D, w: number) {
    if (!this.visible) return;
    const jsMs = this.simMs.avg(WINDOW) + this.renderMs.avg(WINDOW) + this.particleMs.avg(WINDOW);
    const other = Math.max(0, this.frameMs.avg(WINDOW) - jsMs);
    const hz = this.displayHz();
    const lines = [
      `FPS       ${this.fps().toFixed(1)}${hz ? ` / ${hz}Hz` : ''}`,
      `1% low    ${this.low1().toFixed(1)}`,
      `sim FPS   ${this.simFps().toFixed(1)}`,
      `frame     ${this.frameMs.avg(WINDOW).toFixed(2)} ms`,
      `sim       ${this.simMs.avg(WINDOW).toFixed(2)} ms`,
      `render    ${this.renderMs.avg(WINDOW).toFixed(2)} ms`,
      `particles ${this.particleMs.avg(WINDOW).toFixed(2)} ms`,
      `other/gpu ${other.toFixed(2)} ms`,
      `gpu       ${this.gpuBackend}`,
      `canvas    ${this.viewW}x${this.viewH}@${this.dpr}x·${this.layers}L`,
      `scale     ${Math.round(this.renderScale * 100)}%`,
      `enemies   ${this.counts.enemies}`,
      `proj      ${this.counts.projectiles}`,
      `motes     ${this.counts.particles}`,
      `gems/zone ${this.counts.gems}/${this.counts.zones}`,
      `quads     ${this.worldQuads.avg(WINDOW).toFixed(0)} in ${this.worldDrawCalls.avg(WINDOW).toFixed(0)} calls`,
    ];
    ctx.save();
    const pw = 190, lh = 15, pad = 10;
    const ph = lines.length * lh + pad * 2;
    const x = w - pw - 12, y = 12;
    ctx.fillStyle = 'rgba(6,4,16,0.78)';
    ctx.fillRect(x, y, pw, ph);
    ctx.strokeStyle = 'rgba(127,245,255,0.35)';
    ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const fps = this.fps();
    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = i === 0 ? (fps >= 55 ? '#7dffb0' : fps >= 30 ? '#ffd27a' : '#ff5a7a') : '#cdd8ff';
      ctx.fillText(lines[i], x + pad, y + pad + i * lh);
    }
    ctx.restore();
  }
}
