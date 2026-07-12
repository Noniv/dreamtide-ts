// Player-facing settings: audio volumes and a set of performance knobs, each
// with low / medium / high / unlimited presets. MEDIUM is the game's shipped
// default for every knob, so a fresh install plays exactly as before.
//
// The engine, particle system and renderer read the *resolved* numeric values
// off the `settings` singleton every frame, so changes apply live with no
// restart. Persisted to localStorage under its own key.

const STORE_KEY = 'dreamtide_settings_v1';

export type Preset = 'low' | 'medium' | 'high' | 'unlimited';

// Each performance knob maps a preset to a concrete value. Medium always holds
// the original hardcoded constant it replaced.
interface Knob {
  low: number; medium: number; high: number; unlimited: number;
}

// "unlimited" is effectively no cap; the particle pool grows past this on
// demand and the other systems just never throttle at this ceiling.
const UNCAPPED = 1e9;

// Particle emission budget (soft cap): below it every spawn is honoured; past
// it an increasing share of cosmetic particles are dropped. Lower = fewer.
const PARTICLE_SOFT: Knob = { low: 220, medium: 500, high: 900, unlimited: UNCAPPED };
// Particle live-count ceiling. Below it every particle is kept; on unlimited
// the pool grows without bound.
const PARTICLE_MAX: Knob = { low: 1200, medium: 3600, high: 3600, unlimited: UNCAPPED };
// Max concurrent floating damage numbers (non-crit / crit ceilings).
const DMG_TEXT: Knob = { low: 40, medium: 90, high: 160, unlimited: UNCAPPED };
const DMG_TEXT_CRIT: Knob = { low: 80, medium: 200, high: 340, unlimited: UNCAPPED };
// Max concurrent enemy health bars drawn per frame (nearest to the player win).
const HP_BAR: Knob = { low: 12, medium: 40, high: 120, unlimited: UNCAPPED };

// Resolution is its own 3-way (render scale of the world/GPU layers), not a
// low/med/high/unlimited knob. 100% is the shipped default.
export type ResolutionScale = 0.5 | 0.75 | 1;
export const RESOLUTION_OPTIONS: ResolutionScale[] = [0.5, 0.75, 1];

export interface PerfPresets {
  particles: Preset;
  dmgText: Preset;
  hpBars: Preset;
}

export interface StoredSettings {
  musicVol: number;   // 0..1
  sfxVol: number;     // 0..1
  perf: PerfPresets;
  resolution: ResolutionScale;
  hdr: boolean;       // present the scene in HDR when the display supports it
  devEndgame: boolean; // dev-only: start runs in the endgame test scenario
  devFreeTree: boolean; // dev-only: constellation nodes cost nothing
}

const DEFAULTS: StoredSettings = {
  musicVol: 0.7,
  sfxVol: 0.9,
  perf: { particles: 'medium', dmgText: 'medium', hpBars: 'medium' },
  resolution: 1,
  hdr: false,
  devEndgame: false,
  devFreeTree: false,
};

// Whether the current display + OS are in HDR mode. `(dynamic-range: high)` is
// true only when the monitor reports HDR capability AND HDR is switched on in
// the OS (Windows "Use HDR"), so this doubles as the "is HDR usable right now"
// check. Live: the media query fires `change` when the OS toggle flips.
export function hdrSupported(): boolean {
  try { return typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches; }
  catch { return false; }
}

export function watchHdrSupport(cb: (ok: boolean) => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {};
  const mq = matchMedia('(dynamic-range: high)');
  const handler = () => cb(mq.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

// Legacy: render scale used to live under its own key set from the old menu.
// Honour it once so existing players keep their choice, snapped to the nearest
// of the three resolution options.
function migrateRenderScale(): ResolutionScale | null {
  try {
    const raw = localStorage.getItem('dreamtide_render_scale');
    if (raw == null) return null;
    const s = parseFloat(raw);
    if (s <= 0.6) return 0.5;
    if (s <= 0.87) return 0.75;
    return 1;
  } catch { return null; }
}

class Settings {
  musicVol = DEFAULTS.musicVol;
  sfxVol = DEFAULTS.sfxVol;
  perf: PerfPresets = { ...DEFAULTS.perf };
  resolution: ResolutionScale = DEFAULTS.resolution; // render scale, 0.5/0.75/1
  hdr = DEFAULTS.hdr;
  devEndgame = DEFAULTS.devEndgame;
  devFreeTree = DEFAULTS.devFreeTree;

  // resolved numeric knobs (recomputed whenever a preset changes)
  particleSoft = PARTICLE_SOFT.medium;
  particleMax = PARTICLE_MAX.medium;
  dmgTextCap = DMG_TEXT.medium;
  dmgTextCritCap = DMG_TEXT_CRIT.medium;
  hpBarCap = HP_BAR.medium;

  private onResolutionChange: ((scale: number) => void) | null = null;
  private onHdrChange: ((on: boolean) => void) | null = null;

  constructor() {
    this.load();
    this.recompute();
  }

  // render scale the world/GPU layers rasterize at (kept as a getter so callers
  // can read `settings.renderScale` unchanged)
  get renderScale(): number { return this.resolution; }

  private load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<StoredSettings>;
        if (typeof d.musicVol === 'number') this.musicVol = clamp01(d.musicVol);
        if (typeof d.sfxVol === 'number') this.sfxVol = clamp01(d.sfxVol);
        if (d.perf) this.perf = { ...DEFAULTS.perf, ...d.perf };
        if (d.resolution === 0.5 || d.resolution === 0.75 || d.resolution === 1) this.resolution = d.resolution;
        if (typeof d.hdr === 'boolean') this.hdr = d.hdr;
        if (typeof d.devEndgame === 'boolean') this.devEndgame = d.devEndgame;
        if (typeof d.devFreeTree === 'boolean') this.devFreeTree = d.devFreeTree;
      } else {
        const migrated = migrateRenderScale();
        if (migrated != null) this.resolution = migrated;
      }
    } catch { /* corrupted store — keep defaults */ }
  }

  private save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ musicVol: this.musicVol, sfxVol: this.sfxVol, perf: this.perf, resolution: this.resolution, hdr: this.hdr, devEndgame: this.devEndgame, devFreeTree: this.devFreeTree } satisfies StoredSettings));
    } catch { /* private mode */ }
  }

  private recompute() {
    this.particleSoft = PARTICLE_SOFT[this.perf.particles];
    this.particleMax = PARTICLE_MAX[this.perf.particles];
    this.dmgTextCap = DMG_TEXT[this.perf.dmgText];
    this.dmgTextCritCap = DMG_TEXT_CRIT[this.perf.dmgText];
    this.hpBarCap = HP_BAR[this.perf.hpBars];
  }

  setMusicVol(v: number) { this.musicVol = clamp01(v); this.save(); }
  setSfxVol(v: number) { this.sfxVol = clamp01(v); this.save(); }

  // The engine registers this so an HDR change reconfigures the renderer.
  bindHdr(cb: (on: boolean) => void) { this.onHdrChange = cb; }

  setHdr(on: boolean) {
    this.hdr = on;
    this.save();
    if (this.onHdrChange) this.onHdrChange(on);
  }
  setDevEndgame(v: boolean) { this.devEndgame = v; this.save(); }
  setDevFreeTree(v: boolean) { this.devFreeTree = v; this.save(); }

  // The engine registers this so a resolution change triggers a resize.
  bindResolution(cb: (scale: number) => void) { this.onResolutionChange = cb; }

  setResolution(scale: ResolutionScale) {
    this.resolution = scale;
    this.save();
    if (this.onResolutionChange) this.onResolutionChange(scale);
  }

  setPerf<K extends keyof PerfPresets>(key: K, preset: Preset) {
    this.perf[key] = preset;
    this.recompute();
    this.save();
  }

  // Restore every setting to its shipped default. Fires the resolution callback
  // so the renderer resizes if the scale changed.
  resetDefaults() {
    this.musicVol = DEFAULTS.musicVol;
    this.sfxVol = DEFAULTS.sfxVol;
    this.perf = { ...DEFAULTS.perf };
    this.resolution = DEFAULTS.resolution;
    this.hdr = DEFAULTS.hdr;
    this.devEndgame = DEFAULTS.devEndgame;
    this.devFreeTree = DEFAULTS.devFreeTree;
    this.recompute();
    this.save();
    if (this.onResolutionChange) this.onResolutionChange(this.resolution);
    if (this.onHdrChange) this.onHdrChange(this.hdr);
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const settings = new Settings();
