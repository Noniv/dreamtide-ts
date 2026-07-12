// Dreamtide engine: fixed-timestep simulation (60 Hz) with interpolated
// rendering. All gameplay math is a faithful port of the original — same wave
// tables, same scaling curves, same spell stats — restructured around pooled
// entities, stamp-mask hit tracking and grid-routed proximity queries so a
// steady-state frame allocates nothing.

import { ParticleSystem } from './particles';
import { createWorldGPU, QuadList, ShapeList, type WorldGPU } from './worldGPU';
import { PerfMonitor } from './perf';
import { SPELLS, BOONS, EVOLVE, GENERIC, type SpellStats } from './spells';
import { audio } from './audio';
import { dustForRun, type Bonuses } from './meta';
import { settings } from './settings';
import {
  TAU, rand, pick, clamp, dist2, ENEMY_SLOTS,
  type Enemy, type Projectile, type BossProjectile, type BossFire, type Zone, type Beam,
  type Bolt, type Gem, type FloatText, type Pickup, type Orbital,
  makeEnemy, makeProjectile, makeBossProjectile, makeZone, makeBeam, makeBolt,
  makeGem, makeText, Pool, swapRemove, HitMask, HitTimer, maskPool, timerPool,
  SpatialGrid, serpentPoint, SERPENT_PATH_N, SERPENT_PATH_SPACING,
} from './world';
import { renderFrame } from './render';
import { prebakeSprites } from './enemySprites';
import { RELICS, RELIC_IDS, PACTS, type Element, type PactDef, type PactFx } from './relics';

// Logical resolution: every 16:9 monitor sees exactly this slice of the world,
// regardless of pixel resolution (which only affects sharpness). A camera zoom
// (viewScale) maps this design size onto the real window. Off-16:9 monitors
// keep the same vertical framing and see a little extra margin on the long axis
// (option B — never letterboxed, never distorted).
export const DESIGN_W = 1920;
export const DESIGN_H = 1080;

export const STEP = 1 / 60; // fixed simulation timestep (render interpolates against it)
const MAX_STEPS = 5;      // spiral-of-death guard: sim slows instead of hanging
// duration of the melee strike lunge/slash effect (sim + render share it so the
// render can map the countdown to a 0->1 animation phase)
export const MELEE_ANIM_DUR = 0.22;

// the Shade's blink: wind-up while the body folds into a seam of night (the
// exit is marked the whole time), then an unfold at the far end. Sim + render
// share these so the countdowns map cleanly to animation phases.
export const BLINK_WINDUP = 0.55;
export const BLINK_IN = 0.35;

// the dream turns lucid: the horde crawls and essence doubles for these seconds.
// Shared with the renderer so the veil fades cleanly in and out over the window.
export const LUCID_DUR = 6;
// how slow everything hostile runs while lucid — movement, fire cadence AND
// bullets already in flight all scale by this, so the whole battlefield visibly
// dilates into slow-motion rather than just the horde ambling a touch slower.
export const LUCID_SLOW = 0.4;

// boss enrage: after a grace period on screen, a lingering nightmare looses its
// volleys ever faster (up to 1 + MAX × the base rate) so fights can't be kited
// out forever. Fire cadence only — projectile speed stays dodgeable.
// The first minute on screen is a normal fight; over the SECOND minute the fury
// climbs smoothly from 1× to the 3× cap. A player killing at any reasonable pace
// never feels it — only a stalled/kited fight runs into the fangs.
export const BOSS_RAGE_START = 60; // seconds of grace before the fury builds
const BOSS_RAGE_RATE = 1 / 30; // +1× fire rate per 30s → reaches +2× (3× total) after 60s
const BOSS_RAGE_MAX = 2.0;    // caps at 3× base fire rate
export const BOSS_RAGE_FULL = 60; // seconds past START for the tell to peak

// hard-CC saturation: elites, golden wisps and ranged foes shrug free of the
// endgame lock-blanket once they've eaten enough pull/freeze/sleep/knock. Trash
// is never resisted (locking the fodder IS the fantasy) and bosses stay on their
// own per-site gating.
const CC_IMMUNE = 1.6;     // seconds a saturated threat is immune to hard CC
const CC_PULL_RATE = 0.55; // saturation gained per second of being pulled
const CC_HIT = 0.5;        // saturation per discrete freeze / sleep / knock
const CC_DECAY = 0.35;     // saturation bled off per second when free of CC

// Single-target spell priority, expressed as a squared-distance discount: a
// high-value foe reads as if it were sqrt(pri)× closer, so spells favour bosses
// far above golden wisps and elites, which sit well above trash. (Golden wisps
// flee and pay stardust, so they edge out elites.)
const TARGET_PRI_BOSS = 16;   // ~4× effective reach
const TARGET_PRI_GOLDEN = 9;  // ~3× effective reach
const TARGET_PRI_ELITE = 6.25; // ~2.5× effective reach

// Player hurtbox: a circle offset above the sprite origin (feet) so it encloses
// the wizard's body — head through robe — rather than a small patch on the
// chest. Collision checks AND the debug outline both read these, so they can
// never drift apart. (Sprite spans ~ +8 robe hem to ~ -38 hat base, so a r≈18
// circle centred at -15 hugs the visible silhouette.)
export const PLAYER_HURT_DY = -15;
export const PLAYER_HURT_R = 18;

// shortest distance from point (px,py) to the segment (ax,ay)-(bx,by)
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 1e-6 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------- enemy types
export interface EnemyDef {
  hp: number; speed: number; dmg: number; radius: number; xp: number; color: string;
  // melee attack cadence & reach, tuned by spawn order: early types swing slowly
  // with short reach; late types swing faster and reach a little further. Reach
  // is the extra distance beyond the collision radii the strike can land.
  meleeCd: number; meleeReach: number;
  weight: (t: number) => number;
  ranged?: { range: number; cd: number; projSpeed: number; shots: number };
}

export const ENEMY_TYPES: Record<string, EnemyDef> = {
  wisp: { hp: 14, speed: 92, dmg: 8, radius: 13, xp: 1, color: '#7ff5ff', meleeCd: 1.4, meleeReach: 4, weight: () => 10 },
  bat: { hp: 22, speed: 118, dmg: 10, radius: 15, xp: 2, color: '#c48cff', meleeCd: 1.2, meleeReach: 6, weight: (t) => (t > 45 ? 9 : 0) },
  eye: { hp: 46, speed: 66, dmg: 14, radius: 18, xp: 3, color: '#ff9ad5', meleeCd: 1.0, meleeReach: 8, weight: (t) => (t > 110 ? 8 : 0) },
  shade: { hp: 80, speed: 84, dmg: 18, radius: 19, xp: 5, color: '#8a7bff', meleeCd: 0.85, meleeReach: 10, weight: (t) => (t > 190 ? 7 : 0) },
  golem: { hp: 220, speed: 40, dmg: 26, radius: 27, xp: 10, color: '#8fe8ff', meleeCd: 0.7, meleeReach: 12, weight: (t) => (t > 280 ? 5 : 0) },
  siren: {
    hp: 30, speed: 74, dmg: 11, radius: 15, xp: 3, color: '#7dc9ff', meleeCd: 1.1, meleeReach: 6,
    weight: (t) => (t > 75 ? 3 : 0),
    ranged: { range: 330, cd: 2.6, projSpeed: 185, shots: 1 },
  },
  warlock: {
    hp: 95, speed: 58, dmg: 16, radius: 18, xp: 6, color: '#d98cff', meleeCd: 0.9, meleeReach: 9,
    weight: (t) => (t > 210 ? 2.5 : 0),
    ranged: { range: 380, cd: 3.4, projSpeed: 160, shots: 3 },
  },
};

// ------------------------------------------------------------- wave table
interface WaveDef {
  t: number; floor: number; rate: number;
  types: Record<string, number>; hp: number; dmg: number; event?: string;
}

const WAVES: WaveDef[] = [
  { t: 0, floor: 10, rate: 1.25, types: { wisp: 10 }, hp: 1.0, dmg: 1.0 },
  { t: 30, floor: 18, rate: 0.95, types: { wisp: 10, bat: 5 }, hp: 1.35, dmg: 1.15, event: 'ring' },
  { t: 70, floor: 28, rate: 0.8, types: { wisp: 7, bat: 9, siren: 2 }, hp: 1.75, dmg: 1.3 },
  { t: 110, floor: 38, rate: 0.7, types: { bat: 9, wisp: 4, siren: 3, eye: 3 }, hp: 2.25, dmg: 1.5, event: 'pack' },
  { t: 155, floor: 50, rate: 0.62, types: { bat: 6, eye: 7, siren: 3 }, hp: 2.9, dmg: 1.7, event: 'wall' },
  { t: 205, floor: 62, rate: 0.55, types: { eye: 8, bat: 5, siren: 4, shade: 2 }, hp: 3.7, dmg: 1.9, event: 'ring' },
  { t: 260, floor: 76, rate: 0.5, types: { eye: 6, shade: 6, siren: 3, warlock: 1 }, hp: 4.7, dmg: 2.1, event: 'pack' },
  { t: 320, floor: 90, rate: 0.46, types: { shade: 8, eye: 5, warlock: 2 }, hp: 5.9, dmg: 2.3, event: 'wall' },
  { t: 380, floor: 104, rate: 0.43, types: { shade: 7, golem: 4, warlock: 3 }, hp: 7.3, dmg: 2.5, event: 'ring' },
  { t: 440, floor: 120, rate: 0.4, types: { golem: 6, shade: 6, warlock: 3, siren: 2 }, hp: 9.0, dmg: 2.7, event: 'pack' },
  { t: 500, floor: 136, rate: 0.38, types: { golem: 7, shade: 5, warlock: 4 }, hp: 11.0, dmg: 2.9, event: 'wall' },
  { t: 560, floor: 152, rate: 0.36, types: { golem: 8, eye: 6, shade: 6, warlock: 4 }, hp: 13.5, dmg: 3.1, event: 'ring' },
];

// ------------------------------------------------------------- boss archetypes
// Three nightmares share the boss cadence, cycling from a random start each
// run so no two dreams open with the same terror. Each has its own body,
// bullet language and statline; all drop a relic choice when they fall.
interface BossArch {
  type: string;            // enemy sprite/anim to wear
  title: string;           // arrival banner
  color: string;           // banner/flash tint
  hp: number;              // base hp (before wave + count scaling)
  dmg: number;             // base contact damage
  speed: number;           // base chase speed
  radius: number;
  fire: {
    interval: number;      // base seconds between volleys (shrinks with count)
    speed: number;         // base projectile speed
    patterns: (n: number) => string[]; // unlocked patterns by boss number
  };
}

const BOSS_ARCHS: BossArch[] = [
  {
    type: 'eye', title: '☽  THE DEVOURER STIRS  ☾', color: '#c48cff',
    hp: 46, dmg: 26, speed: 52, radius: 61,
    fire: {
      interval: 1.55, speed: 138,
      patterns: (n) => n <= 1 ? ['aimed', 'gaze'] : n <= 3 ? ['aimed', 'gaze', 'spiral'] : ['aimed', 'gaze', 'spiral', 'ring'],
    },
  },
  {
    type: 'golem', title: '☽  THE SUNKEN COLOSSUS WAKES  ☾', color: '#8fe8ff',
    hp: 62, dmg: 34, speed: 34, radius: 72,
    fire: {
      // one signature attack: the double stone ring with a walking gap. The
      // stones leave the body slow, then gather speed as they travel (see the
      // accel handling in the boss-projectile update)
      interval: 2.6, speed: 95,
      patterns: () => ['slam'],
    },
  },
  {
    type: 'siren', title: '☽  THE PALE CHOIR SINGS  ☾', color: '#7dc9ff',
    hp: 34, dmg: 20, speed: 68, radius: 58,
    fire: {
      interval: 1.4, speed: 165,
      patterns: (n) => n <= 1 ? ['burst'] : n <= 3 ? ['burst', 'aimed'] : ['burst', 'aimed', 'spiral'],
    },
  },
  {
    type: 'shade', title: '☽  THE SHADE OF YESTERDAY SLIPS THROUGH  ☾', color: '#8a7bff',
    hp: 40, dmg: 24, speed: 80, radius: 55,
    fire: {
      interval: 1.7, speed: 140,
      patterns: (n) => n <= 2 ? ['blink', 'burst'] : ['blink', 'burst', 'spiral'],
    },
  },
  {
    type: 'warlock', title: '☽  THE HOLLOW COURT CONVENES  ☾', color: '#d98cff',
    hp: 52, dmg: 22, speed: 42, radius: 62,
    fire: {
      // 'volley' — the crown of charge-orbs discharges at the player — is the
      // court's signature; summons alone left it far softer than its peers
      interval: 1.7, speed: 148,
      patterns: (n) => n <= 1 ? ['volley', 'aimed', 'summon'] : n <= 3 ? ['volley', 'aimed', 'summon', 'ring'] : ['volley', 'aimed', 'ring', 'summon', 'spiral'],
    },
  },
];

// spells that live outside the cooldown loop: petals orbit, wisps hover and
// dart on their own clocks, rimeheart orbs drift
const CONTINUOUS = new Set(['petals', 'wisps', 'ward', 'hush', 'frost']);

// dream-tide surges: fixed key set, hoisted so the per-step decay loop never
// calls Object.keys() (a fresh array every sim step otherwise)
const SURGE_KEYS = ['speed', 'dmg', 'haste', 'aoe', 'magnet'] as const;
const SURGE_LOOK: Record<string, { str: string; color: string }> = {
  speed: { str: 'SWIFTNESS SURGES', color: '#7dffb0' },
  dmg: { str: 'POWER SURGES', color: '#ff9ad5' },
  haste: { str: 'HASTE SURGES', color: '#7ff5ff' },
  aoe: { str: 'THE DREAM WIDENS', color: '#c48cff' },
  magnet: { str: 'THE LURE DEEPENS', color: '#ffd27a' },
};

// player position history: 512 steps ≈ 8.5 s at 60 Hz. Powers the Wisp
// Choir's trailing procession.
const HIST_N = 512;

// ---------------------------------------------------------------- interfaces
export interface PlayerSpell { id: string; level: number; cd: number; evolved?: boolean; mastery?: number }

// a singing wisp of the Choir: hovers on the player's path, darts, drifts home
// Rimeheart: a slow orb of condensed cold drifting on a wide orbit. `a` is its
// orbit angle, `hitCd` gates its heavy per-foe graze, `shardCd` clocks the
// evolution's ice-shard volleys.
export interface FrostOrb {
  a: number; radF: number;
  x: number; y: number; px: number; py: number;
  hitCd: HitTimer; shardCd: number; seed: number;
}

export interface Wisp {
  x: number; y: number; px: number; py: number;
  cd: number;                 // time until it may dart again
  state: 0 | 1 | 2;           // 0 hover · 1 darting · 2 drifting home
  dartT: number;              // countdown of the current dart / drift
  sx: number; sy: number;     // where the dart began
  target: Enemy | null; targetUid: number;
  delay: number;              // seconds behind the player on the path
  seed: number;
}

export interface Player {
  x: number; y: number; px: number; py: number;
  hp: number; maxHp: number; speed: number;
  level: number; xp: number; xpNext: number;
  facing: number; animT: number; moving: boolean;
  iframes: number; invuln: number; regenT: number; dead: boolean;
  spells: PlayerSpell[];
  boons: Record<string, number>;
  castPulse: number;
  genericPower: number; genericAoe: number; genericVital: number;
  metaMagnet: number;
  // Somnal Ward: an absorb pool that drinks harm before life, with a break
  // delay before it mends. Hush: the sigh clock. shieldPh drives the panes' spin.
  shield: number; shieldMax: number; shieldT: number; shieldDelay: number; shieldPh: number;
  hushT: number;
}

export interface Choice {
  kind: 'spell' | 'boon' | 'generic' | 'evolve';
  id: string;
  level?: number;
  isNew?: boolean;
  mastery?: boolean;
}

export interface HudState {
  hp: number; maxHp: number; xp: number; xpNext: number; level: number;
  shield: number; shieldMax: number;
  time: number; kills: number;
  ahead: number; // Dark Bargain head start baked into the clock
  spells: { id: string; level: number; evolved: boolean }[];
  spellCap: number;
  boons: Record<string, number>;
  relics: string[];
  dust: number; shards: number; paused: boolean;
}

export interface EngineHooks {
  onHud: (h: HudState, force?: boolean) => void;
  onLevelUp: (choices: Choice[], level: number, banishes: number, rerolls: number) => void;
  // a boss has fallen: the player picks one of these relic ids (or none left)
  onRelic: (choices: string[]) => void;
  // a Whispering Altar was touched: accept the pact or refuse for a small mercy
  onPact: (pact: PactDef) => void;
  onGameOver: (r: { time: number; kills: number; level: number; bonusDust: number; shards: number; relics: string[] }) => void;
  getMeta?: () => Bonuses;
}

interface WaveState extends WaveDef { idx: number }
interface Difficulty { hpMul: number; spdMul: number; rate: number; dmgMul: number; esc: number }

// ================================================================== engine
export class Engine {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement | null = null;
  octx: CanvasRenderingContext2D | null = null;
  debugHitbox = false; // H toggles collision-outline overlay
  hooks: EngineHooks;
  particles = new ParticleSystem();
  // WebGPU scene renderer on the main canvas: background + zones + every
  // entity/particle. null only for the first few frames while the device
  // attaches. WebGPU is REQUIRED — without it the engine shows an error.
  world: WorldGPU | null = null;
  quads = new QuadList();
  shapes = new ShapeList();
  shapesOver = new ShapeList();
  perf = new PerfMonitor();
  grid = new SpatialGrid();
  keys: Record<string, boolean> = {};
  // Render scale: the world + GPU particle layers rasterize at this fraction
  // of the display resolution and are stretched by the compositor (the
  // WebGL-aquarium trick — it renders 1024×1024 regardless of monitor). The
  // overlay layer (damage numbers, perf HUD) stays at full resolution so text
  // remains crisp. Persisted across sessions.
  renderScale = 1;
  running = false;
  paused = false;
  // true only while an actual run is live (set by the UI on start/return-to-menu)
  // — gates the Escape pause toggle so it can't unpause the sim behind the
  // menu/settings/tree overlays, where the engine idles paused.
  inRun = false;
  disposed = false;

  // sim state
  t = 0;
  vt = 0; // visual clock: t + interpolation remainder (cosmetic animation)
  meta: Bonuses = {} as Bonuses;
  player!: Player;
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  bossProjectiles: BossProjectile[] = [];
  zones: Zone[] = [];
  beams: Beam[] = [];
  bolts: Bolt[] = [];
  gems: Gem[] = [];
  texts: FloatText[] = [];
  pickups: Pickup[] = [];
  orbitals: Orbital[] = [];
  frostOrbs: FrostOrb[] = [];
  wisps: Wisp[] = [];
  cam = { x: 0, y: 0, w: 1, h: 1 }; // extent (w/h) is in world units, not pixels
  viewScale = 1;                    // world→screen zoom = innerHeight / DESIGN_H
  shake = 0;
  flash: { color: string; a: number } | null = null;
  banner: { str: string; color: string; life: number; maxLife: number; size: number } | null = null;
  kills = 0;
  bossCount = 0;
  banished = new Set<string>();
  banishCharges = 0;
  rerollCharges = 0;
  surges: Record<string, number> = { speed: 0, dmg: 0, haste: 0, aoe: 0, magnet: 0 };
  breather = 0;
  bonusDust = 0;
  shardsEarned = 0;
  // relics carried this run (see relics.ts) and the pact tallies the altars
  // have woven into the dream
  relics = new Set<string>();
  pact = { dmg: 0, aoe: 0, haste: 0, xp: 0, regen: 0, curseSpd: 0, curseDmg: 0, curseHp: 0, curseFloor: 0, curseElite: 0 };
  // the dream turns lucid: enemies wade through syrup, essence doubles
  lucidT = 0;

  private surgeT = 8;
  private mergeT = 0;
  private chillAmp = 0;
  private cheated = false;
  private starTimer = 75;
  private waveIdx = -1;
  private waveEventAt = 0;
  private waveEventDone = true;
  private goldenAt = 0;
  private pendingLevels = 0;
  // the specific level the currently-open choice belongs to. When several
  // levels are earned at once, player.level jumps to the final value up front,
  // but each queued choice must be offered *for its own level* — otherwise the
  // stat-level check (level % 5) and the displayed level are wrong for all but
  // the last (e.g. crossing 19→20 would offer stats twice instead of once).
  private choiceLevel = 0;
  private hudTimer = 0;
  private spawnTimer = 1.2;
  private eliteTimer = 35;
  private bossTimer = 130;
  private levelUpActive = false;
  private choices: Choice[] = [];
  private burstGuard = false;
  // relic / pact overlay flow
  private relicQueue = 0;          // bosses felled while another overlay was open
  private relicChoiceActive = false;
  private pactActive = false;
  private pactCurrent: PactDef | null = null;
  // whispering altars & lucid moments
  private altarTimer = 105;
  private altarsLeft = 3;
  private lucidTimer = 165;
  // adaptive difficulty director: an invisible hand on the tide. >1 when the
  // player is cruising (swell the horde), <1 when they're drowning (ease off).
  private intensity = 1;
  private dirTimer = 4;
  // per-run boss rotation offset so the first nightmare differs run to run
  private bossSeed = 0;
  // relic timers/counters
  private castCounter = 0;   // Stormcrown
  // Discharge cascade generation: 0 for a directly-killed charged foe,
  // +1 for each death caused by a discharge arc (halves arc damage per step)
  private dischargeDepth = 0;
  private tearCd = 0;        // Frozen Tear
  private chaliceCd = 0;     // Night Chalice
  private cometT = 12;       // Ring of the Comet
  private standT = 0;        // Dream Anchor stillness clock
  // new-school spell state
  private chimeN = 0;        // tolls rung this run (every 4th is the crescendo)
  private wispDarts = 0;     // choir darts loosed (Choir Eternal volleys on 8s)
  // player path ring buffer (Wisp Choir procession)
  private histX = new Float32Array(HIST_N);
  private histY = new Float32Array(HIST_N);
  private histI = 0;
  private histOut = { x: 0, y: 0 };

  // pools & caches
  private enemyPool = new Pool(makeEnemy, 64);
  private projPool = new Pool(makeProjectile, 32);
  private bossProjPool = new Pool(makeBossProjectile, 32);
  private zonePool = new Pool(makeZone, 8);
  private beamPool = new Pool(makeBeam, 4);
  private boltPool = new Pool(makeBolt, 4);
  private gemPool = new Pool(makeGem, 64);
  private textPool = new Pool(makeText, 32);
  private freeSlots: number[] = [];
  private uidCounter = 1;
  private visCache: Enemy[] = [];
  private visT = -1;
  private densCand: Enemy[] = [];
  private densOut = { x: 0, y: 0 };
  private serpOut = { x: 0, y: 0 };
  private serpSpineX = new Float32Array(9); // serpent damage spine scratch
  private serpSpineY = new Float32Array(9);
  private clampOut = { x: 0, y: 0 };
  private viewOut = { left: 0, right: 0, top: 0, bottom: 0 };
  private wave: WaveState = { ...WAVES[0], idx: 0 };
  private waveTypeIds: string[] = [];
  private waveTypeW: number[] = [];
  private waveTypeTotal = 0;
  private waveTypesFor = -1;
  private diff: Difficulty = { hpMul: 1, spdMul: 1, rate: 1, dmgMul: 1, esc: 0 };
  private stormMask = new HitMask();
  // spellStats memo (see spellStats) — cleared each reset(), when meta can change
  private statsCache = new Map<string, SpellStats>();
  // HUD change signature: pushHud skips the React round-trip when nothing shown
  // on screen has actually changed (was a fresh object tree + full React render
  // every 100ms — steady old-gen churn that fed the GC stutters)
  private hudSig = '';
  // reused per-frame perf counts (record() only reads it)
  private perfCounts = { enemies: 0, projectiles: 0, particles: 0, zones: 0, gems: 0, texts: 0 };

  // loop timing
  private last = 0;
  private acc = 0;
  alpha = 0; // interpolation factor for the current render

  constructor(canvas: HTMLCanvasElement, hooks: EngineHooks) {
    this.canvas = canvas;
    this.hooks = hooks;
    // resolution is a performance preset; apply it and re-resize whenever
    // the player changes it in Settings.
    this.renderScale = settings.renderScale;
    settings.bindResolution((scale) => { this.renderScale = scale; this.resize(); });
    settings.bindHdr((on) => this.world?.setHDR(on));
    // Canvas topology (bottom → top):
    //   world  (this.canvas, WebGPU) — background, zones, entities, particles,
    //                                  bloom — the entire game world
    //   overlay(2D)                  — damage text, health bars, banner, HUD
    this.makeOverlay();
    this.reset();
    this.bindInput();
    this.resize();
    window.addEventListener('resize', this.onResize);
    createWorldGPU(canvas).then((world) => {
      if (this.disposed) { world.dispose(); return; }
      this.world = world;
      world.setHDR(settings.hdr);
      this.perf.gpuBackend = `webgpu (${world.adapterLabel})`;
      this.perf.layers = 2;
      this.resize();
    }).catch((e) => {
      this.perf.gpuBackend = 'unavailable';
      this.showGpuError(e);
    });
    (window as any).__engine = this;
  }

  // WebGPU is the only renderer. If it can't start (very old driver, feature
  // disabled), say so plainly instead of limping along on a hidden fallback.
  private showGpuError(e: unknown) {
    console.error('[dreamtide] WebGPU init failed:', e);
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:#0b0a1e;color:#cdd8ff;font:16px/1.6 sans-serif;z-index:9999;text-align:center;padding:32px;';
    div.innerHTML =
      '<div><h2 style="color:#ff9ad5;margin-bottom:12px">Dreamtide needs WebGPU</h2>' +
      'This build renders exclusively with WebGPU and it could not be initialised.<br>' +
      'Please update your graphics drivers or run the desktop build.</div>';
    document.body.appendChild(div);
  }

  private onResize = () => this.resize();

  // Top 2D overlay canvas holding the screen-space overlays.
  private makeOverlay() {
    if (!this.canvas.parentNode || this.overlay) return;
    const c = document.createElement('canvas');
    c.className = 'game-canvas gpu-overlay-layer';
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.pointerEvents = 'none';
    this.canvas.parentNode!.insertBefore(c, this.canvas.nextSibling);
    this.overlay = c;
    this.octx = c.getContext('2d')!;
  }


  // ---------------------------------------------------------------- lifecycle
  reset() {
    this.meta = (this.hooks.getMeta && this.hooks.getMeta()) || ({} as Bonuses);
    this.particles.clear();
    this.releaseAll();
    // The Dark Bargain's head start: the dream begins this many seconds deep.
    // The clock itself starts here — difficulty, the HUD timer and the final
    // time (your record) all agree on how deep the dream ran.
    this.t = this.meta.baneAhead || 0;
    this.vt = this.t;
    this.acc = 0;
    this.cheated = false;
    this.banished.clear();
    this.banishCharges = this.meta.banish || 0;
    this.rerollCharges = this.meta.reroll || 0;
    this.surgeT = 8;
    this.surges = { speed: 0, dmg: 0, haste: 0, aoe: 0, magnet: 0 };
    this.mergeT = 0;
    this.statsCache.clear(); // meta (spellMods/masteryPlus) may have changed
    this.hudSig = '';
    const fm = this.meta.spellMods && this.meta.spellMods.frost;
    this.chillAmp = (fm && fm.special && fm.special.chillAmp) || 0;
    this.breather = 0;
    this.bonusDust = 0;
    this.shardsEarned = 0;
    this.relics.clear();
    this.pact = { dmg: 0, aoe: 0, haste: 0, xp: 0, regen: 0, curseSpd: 0, curseDmg: 0, curseHp: 0, curseFloor: 0, curseElite: 0 };
    this.lucidT = 0;
    this.lucidTimer = rand(150, 210);
    this.relicQueue = 0;
    this.relicChoiceActive = false;
    this.pactActive = false;
    this.pactCurrent = null;
    this.altarTimer = rand(95, 130);
    this.altarsLeft = 3;
    this.intensity = 1;
    this.dirTimer = 4;
    this.bossSeed = (Math.random() * BOSS_ARCHS.length) | 0;
    this.castCounter = 0;
    this.dischargeDepth = 0;
    this.tearCd = 0;
    this.chaliceCd = 0;
    this.cometT = 12;
    this.standT = 0;
    this.chimeN = 0;
    this.wispDarts = 0;
    this.histX.fill(0);
    this.histY.fill(0);
    this.histI = 0;
    this.wisps.length = 0;
    this.banner = null;
    this.starTimer = 75;
    this.waveIdx = -1;
    this.waveEventAt = 0;
    this.waveEventDone = true;
    this.waveTypesFor = -1;
    this.goldenAt = 0;
    this.kills = 0;
    this.pendingLevels = 0;
    this.shake = 0;
    this.hudTimer = 0;
    this.spawnTimer = 1.2;
    this.eliteTimer = 35 / (1 + (this.meta.baneElite || 0) / 100);
    this.bossTimer = 130 / (1 + (this.meta.baneBoss || 0) / 100);
    this.bossCount = 0;
    this.flash = null;
    this.levelUpActive = false;
    // cam extent is world units (see resize): derive it from the same zoom so a
    // run started before the first resize still frames the player correctly.
    const viewScale = window.innerHeight / DESIGN_H;
    const vw = window.innerWidth / viewScale, vh = window.innerHeight / viewScale;
    this.cam = { x: -vw / 2, y: -vh / 2, w: vw, h: vh };
    // (stars and dream-motes are procedural in the background shader now)
    this.player = {
      x: 0, y: 0, px: 0, py: 0,
      hp: 100, maxHp: 100, speed: 190,
      level: 1, xp: 0, xpNext: 6,
      facing: 1, animT: 0, moving: false,
      iframes: 0, invuln: 0, regenT: 0, dead: false,
      spells: [], // filled from the meta loadout below (defaults to Arcane)
      boons: {},
      castPulse: 0,
      genericPower: 0, genericAoe: 0, genericVital: 0,
      metaMagnet: 1,
      shield: 0, shieldMax: 0, shieldT: 0, shieldDelay: 0, shieldPh: 0,
      hushT: 0,
    };
    // constellation (meta tree) bonuses
    const m = this.meta;
    if (m.hp) { this.player.maxHp += m.hp; this.player.hp = this.player.maxHp; }
    if (m.speed) this.player.speed *= 1 + m.speed / 100;
    if (m.magnet) this.player.metaMagnet = 1 + m.magnet / 100;
    // start with the meta loadout (always at least Arcane; sanitized upstream)
    const loadout = (m.loadout && m.loadout.length) ? m.loadout : ['arcane'];
    for (const id of loadout) {
      if (this.player.spells.length >= this.spellCap()) break;
      if (!this.player.spells.find((s) => s.id === id)) this.player.spells.push({ id, level: 1, cd: 0.5 });
    }
    if (this.player.spells.length === 0) this.player.spells.push({ id: 'arcane', level: 1, cd: 0.3 });
    // global start-level (Waking Start keystone) + per-spell start-level (e.g.
    // the Arcane cluster's Waking node boosts only Arcane Missiles)
    for (const s of this.player.spells) {
      const perSpell = (m.spellMods && m.spellMods[s.id] && m.spellMods[s.id].startLv) || 0;
      const bump = (m.startLv || 0) + perSpell;
      if (bump) s.level = Math.min(this.statCap(), s.level + bump);
    }
    this.rebuildOrbitals();
    this.rebuildFrostOrbs();
    this.rebuildWisps();
    prebakeSprites(); // one-time atlas bake so the first heavy frame doesn't stall
  }

  private releaseAll() {
    for (const e of this.enemies) this.enemyPool.release(e);
    for (const pr of this.projectiles) this.freeProjectile(pr);
    for (const bp of this.bossProjectiles) this.bossProjPool.release(bp);
    for (const z of this.zones) this.freeZone(z);
    for (const b of this.beams) {
      if (b.hit) { maskPool.release(b.hit); b.hit = null; }
      if (b.hitT) { timerPool.release(b.hitT); b.hitT = null; }
      this.beamPool.release(b);
    }
    for (const b of this.bolts) this.boltPool.release(b);
    for (const g of this.gems) this.gemPool.release(g);
    for (const tx of this.texts) this.textPool.release(tx);
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.bossProjectiles.length = 0;
    this.zones.length = 0;
    this.beams.length = 0;
    this.bolts.length = 0;
    this.gems.length = 0;
    this.texts.length = 0;
    this.pickups.length = 0;
    this.freeSlots.length = 0;
    for (let i = ENEMY_SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);
    this.visT = -1;
    this.visCache.length = 0;
  }

  private freeProjectile(pr: Projectile) {
    if (pr.hit) { maskPool.release(pr.hit); pr.hit = null; }
    if (pr.hitCd) { timerPool.release(pr.hitCd); pr.hitCd = null; }
    pr.target = null;
    this.projPool.release(pr);
  }

  private freeZone(z: Zone) {
    if (z.hit) { maskPool.release(z.hit); z.hit = null; }
    this.zonePool.release(z);
  }


  resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const worldDpr = dpr * this.renderScale;
    // Anchor the view to a fixed design height so a 16:9 monitor of any
    // resolution shows the same slice of world. Height is the anchor; a wider-
    // than-16:9 window simply reveals extra world on the sides, a taller one on
    // top/bottom — never stretched. dpr/renderScale stay quality-only.
    const viewScale = vh / DESIGN_H;
    this.viewScale = viewScale;
    this.perf.dpr = dpr;
    this.perf.renderScale = this.renderScale;
    this.perf.viewW = vw;
    this.perf.viewH = vh;
    this.cam.w = vw / viewScale; // world units visible (== DESIGN_W on 16:9)
    this.cam.h = vh / viewScale; // world units visible (== DESIGN_H)
    // World canvas rasterizes at renderScale and is stretched by the
    // compositor; the 2D overlay (text) stays at full resolution so it's crisp.
    if (this.world) {
      this.world.resize(vw, vh, worldDpr, viewScale);
    } else {
      this.canvas.style.width = vw + 'px';
      this.canvas.style.height = vh + 'px';
    }
    if (this.overlay && this.octx) {
      this.overlay.width = vw * dpr;
      this.overlay.height = vh * dpr;
      this.overlay.style.width = vw + 'px';
      this.overlay.style.height = vh + 'px';
      // Overlay draws in world units too (so damage text/health bars stay pinned
      // to entities): dpr for crispness × viewScale for the world zoom. The few
      // screen-space HUD pieces (banner, perf) un-zoom themselves in render.
      this.octx.setTransform(dpr * viewScale, 0, 0, dpr * viewScale, 0, 0);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys[e.key.toLowerCase()] = true;
    if (e.key === ' ' && !(e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable))) e.preventDefault();
    if (e.key === 'Escape' && this.inRun && !this.player.dead && !this.levelUpActive && !this.relicChoiceActive && !this.pactActive) {
      this.paused = !this.paused;
      this.pushHud(true);
    }
    // perf overlay: F toggles; hiding it exports the diagnostic log
    if (e.key === 'f' || e.key === 'F') this.perf.toggle();
    // collision-outline debug: H toggles
    if (e.key === 'h' || e.key === 'H') this.debugHitbox = !this.debugHitbox;
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys[e.key.toLowerCase()] = false; };
  // Alt-Tab / focus loss eats the keyup, leaving movement keys latched on;
  // drop every held key when the window blurs.
  private onBlur = () => { this.keys = {}; };
  // suppress the OS context menu (this is a game, not a document); with the
  // menu never opening, focus stays put and keyups arrive normally, so held
  // keys must NOT be cleared here — that would hitch movement on right-click
  private onContextMenu = (e: Event) => { e.preventDefault(); };

  bindInput() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  start() {
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const frameMs = now - this.last;
      let dt = frameMs / 1000;
      this.last = now;
      dt = Math.min(dt, 0.25);

      // ---- fixed-step simulation with an accumulator ----
      let simSteps = 0;
      const simStart = performance.now();
      if (!this.paused) {
        this.acc += dt;
        while (this.acc >= STEP && simSteps < MAX_STEPS) {
          this.simStep(STEP);
          this.acc -= STEP;
          simSteps++;
          if (this.paused) { this.acc = 0; break; } // level-up/death mid-step
        }
        if (this.acc >= STEP) this.acc = this.acc % STEP; // overloaded: drop time
        this.alpha = this.acc / STEP;
      }
      const simMs = performance.now() - simStart;

      // ---- particles advance on the render clock (cosmetic only) ----
      const pStart = performance.now();
      if (!this.paused) this.particles.update(dt);
      let particleMs = performance.now() - pStart;

      // ---- render at display rate, interpolating sim state ----
      this.vt = this.t + this.alpha * STEP;
      const rStart = performance.now();
      renderFrame(this, this.alpha, this.paused ? 0 : dt);
      const rEnd = performance.now();
      let renderMs = rEnd - rStart;

      // GPU particle dispatch happens inside renderFrame; attribute the
      // packing/draw cost to particles for the diagnostic split.
      particleMs += this.lastParticleDrawMs;
      renderMs = Math.max(0, renderMs - this.lastParticleDrawMs);

      // don't record paused frames (menu, level-up, death): they run 0 sim
      // steps and render React UI, which poisons the gameplay averages
      if (!this.paused) {
        const c = this.perfCounts; // reused — record() only reads it
        c.enemies = this.enemies.length;
        c.projectiles = this.projectiles.length + this.bossProjectiles.length;
        c.particles = this.particles.count;
        c.zones = this.zones.length;
        c.gems = this.gems.length;
        c.texts = this.texts.length;
        this.perf.record(frameMs, simMs, simSteps, renderMs, particleMs, c);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  lastParticleDrawMs = 0; // written by renderFrame

  stop() {
    this.running = false;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('contextmenu', this.onContextMenu);
    if (this.world) { this.world.dispose(); this.world = null; }
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    this.octx = null;
  }

  // -------------------------------------------------------------- boon math
  dmgMul() {
    return (1 + 0.12 * (this.player.boons.power || 0)) * (1 + 0.1 * this.player.genericPower)
      * (1 + (this.meta.dmg || 0) / 100) * (this.surges.dmg > 0 ? 1.3 : 1)
      * (1 + this.pact.dmg / 100)
      * (this.relics.has('sovereign') ? 1.35 : 1)
      * (this.relics.has('anchor') && this.standT >= 0.8 ? 1.25 : 1);
  }
  cdMul() {
    const haste = (this.player.boons.haste || 0) * 10 + (this.meta.cast || 0) + this.pact.haste;
    // the surge is multiplicative like every other surge: 30% MORE cast speed on
    // top of whatever haste is already stacked, not a flat +30 points into the sum
    const surge = this.surges.haste > 0 ? 1.3 : 1;
    return 1 / ((1 + haste / 100) * surge);
  }
  magnetR() {
    // combined pull with a soft cap: the first stacks land in full, everything
    // past 2x diminishes hard so the lure never swallows the whole screen
    const mul = (1 + 0.45 * (this.player.boons.magnet || 0)) * this.player.metaMagnet * (this.surges.magnet > 0 ? 1.6 : 1);
    return 90 * (mul <= 2 ? mul : 2 * Math.pow(mul / 2, 0.4));
  }
  // every AoE source — the tree's "area of effect" nodes, the run boon, surge
  // and pact — scales the spell's radius directly.
  aoeMul() { return (1 + 0.1 * this.player.genericAoe) * (1 + (this.meta.aoe || 0) / 100) * (this.surges.aoe > 0 ? 1.3 : 1) * (1 + this.pact.aoe / 100); }
  // resonance marks last longer under the Prism Heart
  markDur(base: number) { return base * (this.relics.has('prismheart') ? 2 : 1); }
  // bonus stardust that keeps pace with the run — a flat "+10" reads as an
  // insult beside a four-digit balance, so rewards pay 5% of what the run has
  // earned so far (sans earlier bonuses, so stars don't compound off stars).
  // The clock-based floor carries the first minutes, when 5% is pennies.
  dustReward(mult = 1) {
    const earned = dustForRun({ kills: this.kills, level: this.player.level, time: this.t, bonusDust: 0 }, this.meta);
    return Math.round(Math.max(20 + this.t / 4, earned * 0.05) * mult);
  }
  statCap() { return 5; }
  // 5 slots filled randomly during a run, plus the loadout (1 by default, up to
  // 4 with +1-slot notables). Default cap stays 6.
  spellCap() { return 5 + Math.min(4, 1 + (this.meta.spellSlots || 0)); }
  evoUnlocked(id: string) { const m = this.meta.spellMods && this.meta.spellMods[id]; return !!(m && m.evo); }

  // Stats are pure in (id, level, mastery) for a whole run — meta/spellMods are
  // fixed between reset()s — so they're cached. Continuous spells (ward, hush,
  // wisps, petals, frost) ask every sim step and the hush veil asks every
  // rendered frame; without the cache each ask allocated two fresh objects.
  // NOTE: the returned object is shared. The only sanctioned mutation is
  // castSpells' `st.evolved = ...`, which every reader sets before use.
  spellStats(id: string, lv: number, mastery = 0): SpellStats {
    const key = id + '|' + lv + '|' + mastery;
    const hit = this.statsCache.get(key);
    if (hit) return hit;
    const st = this.computeSpellStats(id, lv, mastery);
    this.statsCache.set(key, st);
    return st;
  }

  private computeSpellStats(id: string, lv: number, mastery: number): SpellStats {
    const st: SpellStats = { ...SPELLS[id].stats(Math.min(lv, SPELLS[id].maxLevel)) };
    if (mastery > 0) {
      const per = 0.08 + (this.meta.masteryPlus || 0) / 100;
      const bonus = per * Math.sqrt(mastery);
      if (st.damage != null) st.damage *= 1 + bonus;
      if (st.dps != null) st.dps *= 1 + bonus;
      // defensive spells carry no damage — mastery tempers ward & drowse instead
      // (folded here, before the no-mods early-return below can skip it)
      if (SPELLS[id].kind === 'defense') {
        if (st.shield != null) st.shield *= 1 + bonus;
        if (st.recharge != null) st.recharge *= 1 + bonus;
        if (st.knock != null) st.knock *= 1 + bonus;
        if (st.slow != null) st.slow = Math.min(0.92, st.slow * (1 + bonus));
      }
    }
    const m = this.meta.spellMods && this.meta.spellMods[id];
    st.special = (m && m.special) || {};
    if (!m) return st;
    if (st.damage != null) st.damage *= 1 + m.dmg / 100;
    if (st.dps != null) st.dps *= 1 + m.dmg / 100;
    if (st.cooldown) st.cooldown /= 1 + m.cd / 100;
    if (st.radius != null) st.radius *= 1 + m.aoe / 100;
    if (st.length != null) st.length *= 1 + m.aoe / 100;
    if (st.width != null) st.width *= 1 + m.aoe / 100;
    if (st.duration != null) st.duration *= 1 + m.dur / 100;
    if (st.slowDur != null) st.slowDur *= 1 + m.dur / 100;
    if (st.sleepDur != null) st.sleepDur *= 1 + m.dur / 100;
    if (m.count) {
      if (st.count != null) st.count += m.count;
      else if (st.chains != null) st.chains += m.count;
      else if (st.beams != null) st.beams += m.count;
    }
    const S = st.special;
    if (S.seek && st.speed != null) st.speed *= 1 + S.seek / 100;
    if (S.range && st.range != null) st.range *= 1 + S.range / 100;
    if (S.pull && st.pull != null) st.pull *= 1 + S.pull / 100;
    if (S.knock && st.knock != null) st.knock *= 1 + S.knock / 100;
    if (S.slow && st.slow != null) st.slow = Math.min(0.95, st.slow * (1 + S.slow / 100));
    if (S.sleep && st.sleepDur != null) st.sleepDur += S.sleep;
    if (S.vigil && st.duration != null) st.duration += S.vigil;
    if (S.wide && st.width != null) st.width *= 1 + S.wide / 100;
    if (S.reach && st.length != null) st.length *= 1 + S.reach / 100;
    // defensive spells reuse the mote vocabulary: "strength" (m.dmg) tempers the
    // ward / weighs the hush, "quickens" (m.cd — cooldown is 0 for these) speeds
    // mending and sighs. Notables temper the shield (temper) or deepen the drowse
    // (leaden). Mastery is folded above; radius (m.aoe) & hold (m.dur) came through
    // the shared folding. (This branch only runs when the spell has tree mods.)
    if (SPELLS[id].kind === 'defense') {
      const strength = 1 + m.dmg / 100 + (S.temper || 0) / 100;
      const quicken = 1 + m.cd / 100;
      if (st.shield != null) st.shield *= strength;
      if (st.recharge != null) st.recharge *= quicken;
      if (st.knock != null) st.knock *= strength;
      if (st.slow != null && S.leaden) st.slow = Math.min(0.92, st.slow * (1 + S.leaden / 100));
      if (st.interval != null) st.interval /= quicken;
    }
    return st;
  }

  applyBoon(id: string) {
    const p = this.player;
    p.boons[id] = (p.boons[id] || 0) + 1;
    if (id === 'vitality') { p.maxHp += 25; p.hp = Math.min(p.maxHp, p.hp + 25); }
    if (id === 'swift') p.speed *= 1.1;
  }

  addSpell(id: string) {
    const s = this.player.spells.find((s) => s.id === id);
    if (s) s.level++;
    else this.player.spells.push({ id, level: 1, cd: 0.4 });
    if (id === 'petals') this.rebuildOrbitals();
    if (id === 'frost') this.rebuildFrostOrbs();
    if (id === 'wisps') this.rebuildWisps();
  }

  rebuildOrbitals() {
    const s = this.player.spells.find((s) => s.id === 'petals');
    for (const o of this.orbitals) timerPool.release(o.hitCd);
    this.orbitals = [];
    if (!s) return;
    const st = this.spellStats('petals', s.level);
    const mk = (a: number, dir: number, radF: number): Orbital => ({
      a, dir, radF, x: this.player.x, y: this.player.y, px: this.player.x, py: this.player.y,
      hitCd: timerPool.acquire().begin(),
    });
    for (let i = 0; i < st.count!; i++) this.orbitals.push(mk((i / st.count!) * TAU, 1, 1));
    // Wild Garden: a second, wider ring waltzing the other way
    if (s.evolved) {
      for (let i = 0; i < st.count!; i++) this.orbitals.push(mk((i / st.count!) * TAU + TAU / (st.count! * 2), -1, 1.45));
    }
  }

  rebuildFrostOrbs() {
    const s = this.player.spells.find((s) => s.id === 'frost');
    for (const o of this.frostOrbs) timerPool.release(o.hitCd);
    this.frostOrbs = [];
    if (!s) return;
    const st = this.spellStats('frost', s.level, s.mastery || 0);
    const n = Math.max(1, st.count!);
    for (let i = 0; i < n; i++) {
      // spread the orbs evenly around the orbit; alternate their orbit radius a
      // touch so two orbs sweep slightly different rings rather than trailing in
      // lockstep
      this.frostOrbs.push({
        a: (i / n) * TAU, radF: 1 + (i % 2) * 0.16,
        x: this.player.x, y: this.player.y, px: this.player.x, py: this.player.y,
        hitCd: timerPool.acquire().begin(), shardCd: rand(0.2, 0.6), seed: rand(0, TAU),
      });
    }
  }

  // -------------------------------------------------------------- level ups
  // The early curve is untouched; past level 12 each level grows a further 5%
  // costlier. Late-run power still climbs, but the reverie stops dissolving
  // into back-to-back upgrade menus (a third of playtime, at its worst).
  xpNextFor(level: number) {
    return Math.floor((6 + Math.pow(level, 1.55) * 3.4) * (1 + Math.max(0, level - 12) * 0.05));
  }

  gainXp(n: number) {
    const p = this.player;
    if (p.dead) return;
    p.xp += n * (1 + (this.meta.xp || 0) / 100) * this.baneXpMul()
      * (1 + this.pact.xp / 100) * (this.lucidT > 0 ? 2 : 1);
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = this.xpNextFor(p.level);
      this.pendingLevels++;
    }
    this.maybeOpenLevelUp();
  }

  maybeOpenLevelUp() {
    if (this.player.dead) return;
    if (this.levelUpActive || this.relicChoiceActive || this.pactActive || this.pendingLevels <= 0) return;
    this.pendingLevels--;
    // this choice is for the earliest not-yet-resolved level. player.level is
    // already the final value; subtract the levels still queued behind this one.
    this.choiceLevel = this.player.level - this.pendingLevels;
    this.offerChoices();
  }

  buildChoicePool() {
    const p = this.player;
    const isStatLevel = this.choiceLevel % 5 === 0;
    const banned = (kind: string, id: string) => this.banished.has(`${kind}:${id}`);
    const pool: Choice[] = [];
    const genericPool = () => {
      pool.push({ kind: 'generic', id: 'power', level: p.genericPower + 1 });
      pool.push({ kind: 'generic', id: 'aoe', level: p.genericAoe + 1 });
      pool.push({ kind: 'generic', id: 'vital', level: p.genericVital + 1 });
    };

    const evolvePool: Choice[] = [];
    for (const id of Object.keys(SPELLS)) {
      const owned = p.spells.find((s) => s.id === id);
      if (owned && !owned.evolved && owned.level >= this.statCap() && this.evoUnlocked(id) && !banned('spell', id)) {
        evolvePool.push({ kind: 'evolve', id });
      }
    }

    const pushWeighted = (c: Choice) => {
      const m = this.meta.spellMods && this.meta.spellMods[c.id];
      const extra = (m && m.weight) || 0;
      for (let i = 0; i <= extra; i++) pool.push(c);
    };

    if (isStatLevel) {
      for (const id of Object.keys(BOONS)) {
        if ((p.boons[id] || 0) < BOONS[id].max && !banned('boon', id)) pool.push({ kind: 'boon', id, level: (p.boons[id] || 0) + 1 });
      }
      if (pool.length === 0) genericPool();
    } else {
      for (const id of Object.keys(SPELLS)) {
        if (banned('spell', id)) continue;
        const owned = p.spells.find((s) => s.id === id);
        if (!owned && p.spells.length < this.spellCap()) pushWeighted({ kind: 'spell', id, isNew: true });
        else if (owned && owned.level < this.statCap()) pushWeighted({ kind: 'spell', id, isNew: false, level: owned.level + 1 });
        else if (owned && (owned.evolved || !this.evoUnlocked(id))) pushWeighted({ kind: 'spell', id, isNew: false, mastery: true, level: (owned.mastery || 0) + 1 });
      }
      if (pool.length === 0 && evolvePool.length === 0) genericPool();
    }
    return { pool, evolvePool, isStatLevel };
  }

  buildChoices(): Choice[] {
    const { pool, evolvePool, isStatLevel } = this.buildChoicePool();
    const choices: Choice[] = [];
    const nChoices = 3 + (this.meta.fourfold || 0);
    const keyOf = (c: Choice) => `${c.kind === 'evolve' ? 'spell' : c.kind}:${c.id}`;
    const taken = new Set<string>();
    if (evolvePool.length && !isStatLevel) {
      const ev = evolvePool[(Math.random() * evolvePool.length) | 0];
      choices.push(ev);
      taken.add(keyOf(ev));
    }
    while (choices.length < nChoices && pool.length) {
      const i = (Math.random() * pool.length) | 0;
      const c = pool.splice(i, 1)[0];
      if (taken.has(keyOf(c))) continue;
      taken.add(keyOf(c));
      choices.push(c);
    }
    if (choices.length === 0) choices.push({ kind: 'generic', id: 'power', level: this.player.genericPower + 1 });
    return choices;
  }

  offerChoices() {
    this.choices = this.buildChoices();
    // A hand of nothing but masteries and amplifies is barely a decision —
    // the saturated endgame build hits one every few seconds, and stopping the
    // run for it is pure menu fatigue. Resolve it in-world instead: prefer a
    // mastery (it tracks the build), fall back to a generic, and float the
    // result where the fight is happening.
    const trivial = this.choices.length > 0 && this.choices.every(
      (c) => c.kind === 'generic' || (c.kind === 'spell' && !!c.mastery),
    );
    if (trivial) {
      const pick = this.choices.find((c) => c.kind === 'spell') || this.choices[0];
      let name: string;
      if (pick.kind === 'spell') {
        const s = this.player.spells.find((x) => x.id === pick.id);
        if (s) s.mastery = (s.mastery || 0) + 1;
        name = `${SPELLS[pick.id].name} MASTERY`;
      } else {
        this.applyGeneric(pick.id);
        name = GENERIC[pick.id].name.toUpperCase();
      }
      audio.choose();
      const p = this.player;
      this.spawnText(p.x, p.y - 74, `REVERIE ${this.choiceLevel} — ${name}`, '#ffd27a', 1.5, -26, 15);
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * TAU;
        this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(90, 220), vy: Math.sin(a) * rand(90, 220), life: rand(0.4, 0.8), size: rand(2, 4), color: '#ffd27a', mode: 'star', rotV: rand(-4, 4), drag: 0.91 });
      }
      this.pushHud(true);
      this.maybeOpenLevelUp(); // drain any further queued levels the same way
      return;
    }
    this.levelUpActive = true;
    this.paused = true;
    audio.levelUp();
    this.hooks.onLevelUp(this.choices, this.choiceLevel, this.banishCharges, this.rerollCharges);
  }

  reroll() {
    if (this.rerollCharges <= 0) return;
    this.rerollCharges--;
    audio.reroll();
    this.choices = this.buildChoices();
    this.hooks.onLevelUp([...this.choices], this.choiceLevel, this.banishCharges, this.rerollCharges);
  }

  banish(choice: Choice) {
    if (this.banishCharges <= 0) return;
    this.banishCharges--;
    const keyOf = (c: Choice) => `${c.kind === 'evolve' ? 'spell' : c.kind}:${c.id}`;
    this.banished.add(keyOf(choice));
    audio.banish();
    const idx = this.choices.indexOf(choice);
    const shown = new Set(this.choices.map(keyOf));
    const { pool, evolvePool } = this.buildChoicePool();
    const fresh = [...pool, ...evolvePool].filter((c) => !shown.has(keyOf(c)));
    const repl = fresh.length ? fresh[(Math.random() * fresh.length) | 0] : null;
    if (idx >= 0) {
      if (repl) this.choices.splice(idx, 1, repl);
      else this.choices.splice(idx, 1);
    }
    this.hooks.onLevelUp([...this.choices], this.choiceLevel, this.banishCharges, this.rerollCharges);
  }

  chooseUpgrade(choice: Choice): boolean {
    if (!this.levelUpActive) return false;
    if (choice.kind === 'spell' && choice.mastery) {
      const s = this.player.spells.find((x) => x.id === choice.id);
      if (s) s.mastery = (s.mastery || 0) + 1;
    } else if (choice.kind === 'spell') this.addSpell(choice.id);
    else if (choice.kind === 'boon') this.applyBoon(choice.id);
    else if (choice.kind === 'generic') this.applyGeneric(choice.id);
    else if (choice.kind === 'evolve') {
      const s = this.player.spells.find((x) => x.id === choice.id);
      if (s) {
        s.evolved = true;
        s.level = Math.max(s.level, SPELLS[choice.id].maxLevel);
        if (choice.id === 'petals') this.rebuildOrbitals();
        if (choice.id === 'frost') this.rebuildFrostOrbs();
        this.setBanner(`${SPELLS[choice.id].name.toUpperCase()} → ${EVOLVE[choice.id].name.toUpperCase()}`, SPELLS[choice.id].color);
        this.flash = { color: '255,210,122', a: 0.3 };
      }
    }
    audio.choose();
    this.levelUpActive = false;
    this.paused = this.player.dead;
    const p = this.player;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU;
      this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(120, 300), vy: Math.sin(a) * rand(120, 300), life: rand(0.5, 1.1), size: rand(2, 5), color: '#ffd27a', color2: '#b48cff', mode: 'star', rotV: rand(-4, 4), drag: 0.92 });
    }
    this.pushHud(true);
    this.maybeOpenLevelUp();
    return this.levelUpActive;
  }

  // -------------------------------------------------------------- relics
  // A fallen boss offers one of three relics the player doesn't yet hold.
  // Opened from simStep (never mid-callback) so pausing is always clean.
  private offerRelics() {
    const avail = RELIC_IDS.filter((id) => !this.relics.has(id));
    this.relicQueue--;
    if (avail.length === 0) {
      // every relic already claimed — the dream pays in stardust instead
      const d = this.dustReward(3);
      this.bonusDust += d;
      this.setBanner(`+${d} STARDUST`, '#ffd27a');
      return;
    }
    const picks: string[] = [];
    while (picks.length < 3 && avail.length) {
      picks.push(avail.splice((Math.random() * avail.length) | 0, 1)[0]);
    }
    this.relicChoiceActive = true;
    this.paused = true;
    audio.levelUp();
    this.hooks.onRelic(picks);
  }

  chooseRelic(id: string) {
    if (!this.relicChoiceActive || this.relics.has(id) || !RELICS[id]) return;
    this.relics.add(id);
    const p = this.player;
    // relics with an immediate price or gift settle it on pickup
    if (id === 'sovereign') {
      p.maxHp = Math.max(40, Math.round(p.maxHp * 0.8));
      p.hp = Math.min(p.hp, p.maxHp);
    } else if (id === 'cartographer') {
      // the map redraws itself at once: more altars, and the next wonders
      // are already on their way
      this.altarsLeft += 2;
      this.altarTimer = Math.min(this.altarTimer, 45);
      this.starTimer = Math.min(this.starTimer, 20);
    }
    audio.choose();
    this.setBanner(RELICS[id].name.toUpperCase(), RELICS[id].color, 3.4, 30);
    this.flash = { color: '255,210,122', a: 0.3 };
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * TAU;
      this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(140, 340), vy: Math.sin(a) * rand(140, 340), life: rand(0.5, 1.2), size: rand(2, 6), color: RELICS[id].color, color2: '#ffffff', mode: 'star', rotV: rand(-5, 5), drag: 0.9 });
    }
    this.relicChoiceActive = false;
    this.paused = p.dead;
    this.pushHud(true);
    this.maybeOpenLevelUp(); // essence gathered during the boss fight
  }

  // -------------------------------------------------------------- pacts
  resolvePact(accept: boolean) {
    if (!this.pactActive || !this.pactCurrent) return;
    const p = this.player;
    if (accept) {
      const fx: PactFx = this.pactCurrent.fx;
      this.pact.dmg += fx.dmg || 0;
      this.pact.aoe += fx.aoe || 0;
      this.pact.haste += fx.haste || 0;
      this.pact.xp += fx.xp || 0;
      this.pact.regen += fx.regen || 0;
      this.pact.curseSpd += fx.curseSpd || 0;
      this.pact.curseDmg += fx.curseDmg || 0;
      this.pact.curseHp += fx.curseHp || 0;
      this.pact.curseFloor += fx.curseFloor || 0;
      this.pact.curseElite += fx.curseElite || 0;
      if (fx.hp) { p.maxHp += fx.hp; p.hp = Math.min(p.maxHp, p.hp + fx.hp); }
      if (fx.healFull) p.hp = p.maxHp;
      audio.banish();
      this.setBanner('THE PACT IS SEALED', '#c48cff', 3.2, 28);
      this.flash = { color: '154,92,255', a: 0.32 };
      for (let i = 0; i < 46; i++) {
        const a = rand(0, TAU);
        this.particles.spawn({ x: p.x, y: p.y - 12, vx: Math.cos(a) * rand(80, 280), vy: Math.sin(a) * rand(80, 280), life: rand(0.5, 1), size: rand(2, 5), color: '#c48cff', color2: '#ff5a7a', mode: 'rune', rotV: rand(-4, 4), drag: 0.9 });
      }
    } else {
      // a small mercy for the cautious: some life and a scatter of essence
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2);
      const v = Math.max(2, Math.round(3 * this.diff.hpMul));
      for (let k = 0; k < 6; k++) this.spawnGem(p.x + rand(-70, 70), p.y + rand(-70, 70), v, true, false, false, rand(0, TAU));
      audio.heal();
      this.setBanner('THE ALTAR SLEEPS', '#8a7bff');
    }
    this.pactActive = false;
    this.pactCurrent = null;
    this.paused = p.dead;
    this.pushHud(true);
    this.maybeOpenLevelUp();
  }

  // Dev/test helper (menu toggle): jump straight into an endgame perf
  // scenario. The run clock starts at `t` seconds, every spell slot is filled
  // with a random spell at the stat cap (evolved where the constellation
  // unlocked it), and the player gets a mid-run-ish level and HP pool so the
  // test doesn't end on first contact.
  devEndgame(t = 360) {
    this.t = t;
    // boss cadence as if the run had been going: first boss at 130s, then +160s
    this.bossCount = Math.max(0, Math.floor((t - 130) / 160) + 1);
    this.bossTimer = (130 + this.bossCount * 160 - t) / (1 + (this.meta.baneBoss || 0) / 100);
    const p = this.player;
    p.level = 25;
    p.xpNext = this.xpNextFor(p.level);
    p.maxHp += 150;
    p.hp = p.maxHp;
    const ids = Object.keys(SPELLS);
    while (p.spells.length < this.spellCap() && ids.length) {
      const id = ids.splice((Math.random() * ids.length) | 0, 1)[0];
      if (p.spells.find((s) => s.id === id)) continue;
      p.spells.push({ id, level: 1, cd: rand(0, 0.5) });
    }
    for (const s of p.spells) {
      if (this.evoUnlocked(s.id)) { s.evolved = true; s.level = SPELLS[s.id].maxLevel; }
      else s.level = this.statCap();
    }
    this.rebuildOrbitals();
    this.rebuildFrostOrbs();
    this.rebuildWisps();
    this.setBanner('⚗ ENDGAME TEST — 6:00', '#7ff5ff');
    this.pushHud(true);
  }

  applyGeneric(id: string) {
    const p = this.player;
    if (id === 'power') p.genericPower++;
    if (id === 'aoe') p.genericAoe++;
    if (id === 'vital') { p.genericVital++; p.maxHp += 15; p.hp = Math.min(p.maxHp, p.hp + 15); }
  }

  // -------------------------------------------------------------- waves
  private computeWave() {
    // the run clock already starts baneAhead seconds deep (see reset)
    const T = this.t;
    let idx = 0;
    for (let i = 0; i < WAVES.length; i++) { if (T >= WAVES[i].t) idx = i; else break; }
    const w = WAVES[idx];
    const out = this.wave;
    out.t = w.t; out.floor = w.floor; out.rate = w.rate; out.types = w.types;
    out.hp = w.hp; out.dmg = w.dmg; out.event = w.event; out.idx = idx;
    if (idx === WAVES.length - 1) {
      const extra = Math.floor((T - w.t) / 60);
      if (extra > 0) {
        out.idx = idx + extra;
        out.floor = Math.min(260, w.floor + extra * 16);
        out.event = ['ring', 'wall', 'pack'][extra % 3];
      }
    }
    // weighted type table, rebuilt only when the window changes
    if (this.waveTypesFor !== idx) {
      this.waveTypesFor = idx;
      this.waveTypeIds.length = 0;
      this.waveTypeW.length = 0;
      this.waveTypeTotal = 0;
      for (const [id, x] of Object.entries(out.types)) {
        this.waveTypeIds.push(id);
        this.waveTypeW.push(x);
        this.waveTypeTotal += x;
      }
    }
  }

  private pickType(): string {
    let r = Math.random() * this.waveTypeTotal;
    for (let i = 0; i < this.waveTypeIds.length; i++) {
      r -= this.waveTypeW[i];
      if (r <= 0) return this.waveTypeIds[i];
    }
    return this.waveTypeIds[0];
  }

  // past minute 7 the dream unravels: an ever-climbing endgame intensity
  endgame() {
    return Math.max(0, (this.t - 420) / 60);
  }

  // Beta players felt overwhelmed too quickly: the first minutes ramped a touch
  // too steeply. This eases early spawn pressure (fewer concurrent bodies, a
  // slightly slower tide) with the relief weighted toward the early minutes,
  // then relaxes to exactly 1.0 by the 7-minute mark — so mid/endgame pacing is
  // left precisely as it was. Both ends (t=0 and t=420) sit at ~1; only the
  // steep middle of the early ramp is flattened.
  private earlyEase() {
    if (this.t >= 420) return 1;
    const x = this.t / 420; // 0 at the start → 1 at the 7-minute mark
    return 1 - 0.10 * Math.sin(Math.PI * Math.sqrt(x));
  }

  // Bargain-summoned extras grant no net essence: essence is scaled by the
  // share of the horde that would exist anyway (Dark Bargain floor nodes and
  // the Pact of the Deep both count). More action and more stardust for the
  // player — not more time trapped in upgrade menus. The penalty naturally
  // relaxes late-run as the extra bodies shrink relative to the true tide.
  baneXpMul() {
    const m = this.meta;
    const esc = this.endgame();
    const natural = Math.max(6, this.wave.floor + Math.floor(esc * esc * 2.2));
    const extra = (m.baneFloor || 0) + this.pact.curseFloor;
    const rate = (m.baneRate || 0) / 100;
    return Math.max(0.25, (natural / (natural + extra)) / (1 + rate * 0.6));
  }

  private computeDifficulty() {
    const w = this.wave;
    const m = this.meta;
    const esc = this.endgame();
    const d = this.diff;
    d.hpMul = (w.hp + esc * 3.0 + esc * esc * 1.3) * (1 + (m.baneHp || 0) / 100) * (1 + this.pact.curseHp / 100);
    d.spdMul = (1 + Math.min(0.5, this.t * 0.0008)) * (1 + Math.min(6, esc * 0.28)) * (1 + (m.baneSpeed || 0) / 100) * (1 + this.pact.curseSpd / 100);
    d.rate = w.rate / (1 + (m.baneRate || 0) / 100) / (1 + Math.min(1.6, esc * 0.13));
    d.dmgMul = (w.dmg + esc * 0.8 + esc * esc * 0.18 + esc * esc * esc * 0.012) * (1 + (m.baneDmg || 0) / 100) * (1 + this.pact.curseDmg / 100);
    d.esc = esc;
  }

  setBanner(str: string, color = '#cdd8ff', life = 3, size = 24) {
    this.banner = { str, color, life, maxLife: life, size };
  }

  // -------------------------------------------------------------- spawning
  // A point inside the visible rectangle along ray `ang` from the player.
  // frac scales the distance toward the screen edge (1 = right at the edge minus
  // `margin`), computed against the true rectangle boundary so foes land in a
  // band near the rim without ever slipping off-screen on any aspect ratio.
  private visibleEdgePoint(ang: number, fracMin: number, fracMax: number, margin: number) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const hx = Math.max(20, this.cam.w * 0.5 - margin);
    const hy = Math.max(20, this.cam.h * 0.5 - margin);
    const tx = Math.abs(c) > 1e-4 ? hx / Math.abs(c) : Infinity;
    const ty = Math.abs(s) > 1e-4 ? hy / Math.abs(s) : Infinity;
    const R = Math.min(tx, ty) * rand(fracMin, fracMax);
    return { x: this.player.x + c * R, y: this.player.y + s * R };
  }

  spawnEnemy(typeId: string, elite = false, boss = false): Enemy | null {
    if (this.freeSlots.length === 0) return null; // hard cap, never reached in practice
    // bosses cycle through the three nightmares from a per-run random start
    const arch = boss ? BOSS_ARCHS[(this.bossSeed + this.bossCount - 1 + BOSS_ARCHS.length * 8) % BOSS_ARCHS.length] : null;
    if (arch) typeId = arch.type;
    const def = ENEMY_TYPES[typeId] || ENEMY_TYPES.wisp;
    const d = this.diff;
    const ang = Math.random() * TAU;
    // Where the newcomer tears into the dream:
    //   bosses  — already on-screen, but hugging the very edges: a nightmare you
    //             see arrive, never one that blooms in your lap
    //   everyone else (elites + trash) — just beyond the visible rectangle,
    //             streaming inward. Nothing but a boss ever spawns in view, so a
    //             foe can never simply pop into being on top of the dreamer.
    const offscreen = Math.hypot(this.cam.w, this.cam.h) * 0.5;
    let sx: number, sy: number;
    if (boss) {
      const pt = this.visibleEdgePoint(ang, 0.86, 1.0, 70);
      sx = pt.x; sy = pt.y;
    } else {
      const R = offscreen + 80;
      sx = this.player.x + Math.cos(ang) * R;
      sy = this.player.y + Math.sin(ang) * R;
    }
    const mul = boss ? 1 : elite ? 7 : 1;
    const e = this.enemyPool.acquire();
    e.uid = this.uidCounter++;
    e.slot = this.freeSlots.pop()!;
    e.type = typeId;
    e.boss = boss;
    e.elite = elite;
    e.golden = false;
    e.dead = false;
    e.x = sx;
    e.y = sy;
    e.px = e.x; e.py = e.y;
    e.hp = arch
      ? arch.hp * d.hpMul * (35 + this.bossCount * 25)
      : def.hp * d.hpMul * mul;
    e.speed = arch ? arch.speed * d.spdMul : def.speed * d.spdMul * (elite ? 1.12 : 1);
    e.dmg = arch ? arch.dmg * d.dmgMul : def.dmg * d.dmgMul * (elite ? 1.5 : 1);
    e.radius = arch ? arch.radius : def.radius * (elite ? 1.55 : 1);
    e.xp = Math.max(1, Math.round(def.xp * (1 + Math.min(2.2, (d.hpMul - 1) * 0.3)) / (1 + d.esc * 0.12))) * (elite ? 6 : 1);
    e.color = def.color;
    e.slow = 0; e.slowT = 0; e.hitFlash = 0;
    e.ccSat = 0; e.ccImmT = 0; e.rageT = 0;
    e.chargeT = 0; e.chargeDmg = 0; e.brandT = 0; e.reactCd = 0;
    e.nbT = 0; e.nbDps = 0; e.nbPct = 0; e.nbTick = 0; e.nbAmp = 0; e.nbSpread = false; e.nbBurst = 0;
    e.animT = Math.random() * 10;
    e.seed = Math.random() * 1000;
    e.knbx = 0; e.knby = 0;
    e.goldT = 0; e.shootCd = -1; e.dmgTextT = 0;
    // melee: bosses swing faster with more reach; start ready to strike on contact
    e.meleeBaseCd = def.meleeCd * (boss ? 0.6 : elite ? 0.85 : 1);
    e.meleeReach = def.meleeReach * (boss ? 2.4 : elite ? 1.4 : 1);
    e.meleeCd = 0; e.meleeAnim = 0;
    e.ranged = def.ranged ? { ...def.ranged } : null;
    e.bossFire = null;
    // endgame variance: past minute 7, each foe rolls its own extra menace
    const esc = d.esc;
    if (esc > 0 && !boss) {
      if (Math.random() < Math.min(0.6, 0.12 + esc * 0.05)) {
        e.speed *= 1 + rand(0.15, 0.15 + Math.min(0.55, esc * 0.06));
      }
      const rdef = def.ranged;
      if (rdef) {
        const rangeF = 1 + rand(0, Math.min(1.0, esc * 0.09));
        const speedF = 1 + rand(0, Math.min(1.3, esc * 0.12));
        const extraShots = Math.random() < Math.min(0.7, esc * 0.08) ? 1 + ((Math.random() * Math.min(3, esc * 0.25)) | 0) : 0;
        e.ranged = {
          range: rdef.range * rangeF,
          cd: rdef.cd / (1 + Math.min(0.5, esc * 0.03)),
          projSpeed: rdef.projSpeed * speedF,
          shots: rdef.shots + extraShots,
        };
      }
      // deep endgame: a share of the melee tide (drifting eyes, slipping shades)
      // learns to spit from range, harrying from beyond rift reach so the CC-
      // blanket can never neutralise the whole screen at once
      if (esc > 1.5 && !e.ranged && (typeId === 'eye' || typeId === 'shade') && !elite) {
        if (Math.random() < Math.min(0.4, (esc - 1.5) * 0.09)) {
          e.ranged = {
            range: 300 + rand(0, 120),
            cd: 2.8 / (1 + Math.min(0.5, esc * 0.03)),
            projSpeed: 165 + rand(0, 40),
            shots: 1 + (Math.random() < esc * 0.05 ? 1 : 0),
          };
        }
      }
    }
    e.maxHp = e.hp;
    if (e.ranged) e.shootCd = rand(0.5, e.ranged.cd);
    this.enemies.push(e);
    if (boss && arch) {
      audio.bossRoar();
      const [fr, fg, fb] = [1, 3, 5].map((i) => parseInt(arch.color.slice(i, i + 2), 16));
      this.flash = { color: `${fr},${fg},${fb}`, a: 0.35 };
      this.setBanner(arch.title, arch.color, 4.2, 38);
      this.spawnText(e.x, e.y - 60, arch.title.replace(/[☽☾]/g, '').trim(), arch.color, 2.4, -12, 22);
      this.shake = 13; // a boss clawing into the dream is one of the few things that shakes it
      const n = this.bossCount;
      e.bossFire = {
        cd: 0,
        interval: Math.max(0.7, arch.fire.interval - n * 0.12),
        speed: arch.fire.speed + n * 12,
        spin: rand(0, TAU),
        spinV: (n % 2 ? 1 : -1) * (0.5 + n * 0.08),
        patterns: arch.fire.patterns(n),
        pIdx: 0,
        hold: 0,
        blinkT: 0, blinkDur: BLINK_WINDUP, blinkIn: 0, bx: 0, by: 0,
        gapAng: null, gapDir: Math.random() < 0.5 ? 1 : -1,
      };
    }
    return e;
  }

  private shootBossProj(x: number, y: number, ang: number, spd: number, r: number, dmg: number, life: number, color: string | null, accel = 0, maxSpd = 0) {
    const bp = this.bossProjPool.acquire();
    bp.dead = false;
    bp.x = x; bp.y = y; bp.px = x; bp.py = y;
    bp.vx = Math.cos(ang) * spd;
    bp.vy = Math.sin(ang) * spd;
    bp.life = life; bp.r = r; bp.dmg = dmg; bp.color = color;
    bp.accel = accel; bp.maxSpd = maxSpd;
    bp.reflected = false; bp.parryT = 0;
    this.bossProjectiles.push(bp);
  }

  private updateBossFire(e: Enemy, dt: number) {
    const p = this.player;
    const bf = e.bossFire || (e.bossFire = { cd: 0, interval: 1.6, speed: 130, spin: 0, spinV: 0.6, patterns: ['aimed'], pIdx: 0, hold: 0, blinkT: 0, blinkDur: BLINK_WINDUP, blinkIn: 0, bx: 0, by: 0, gapAng: null, gapDir: 1 });
    const n = this.bossCount;
    // lucid dilates the boss too: its spin and volley clock crawl with everything else
    const lucid = this.lucidT > 0 ? LUCID_SLOW : 1;
    bf.spin += bf.spinV * dt * lucid;
    bf.hold = Math.max(0, bf.hold - dt);
    // enrage: the longer a nightmare lingers, the faster it fires — a soft push
    // to finish the fight rather than kite it. A one-shot roar marks the turn.
    const wasEnraged = e.rageT > BOSS_RAGE_START;
    e.rageT += dt;
    if (!wasEnraged && e.rageT > BOSS_RAGE_START) audio.bossEnrage(this.panOf(e.x));
    const rage = 1 + Math.min(BOSS_RAGE_MAX, Math.max(0, e.rageT - BOSS_RAGE_START) * BOSS_RAGE_RATE);
    // a blink in progress owns the turn: the fire clock pauses while the
    // Shade folds away, steps, and unfolds (see updateBlink)
    if (this.updateBlink(e, bf, dt)) return;
    bf.cd -= dt * lucid;
    if (bf.cd > 0) return;
    bf.cd = (bf.interval / rage) * rand(0.9, 1.1);
    const pat = bf.patterns[bf.pIdx % bf.patterns.length];
    bf.pIdx++;
    const baseA = Math.atan2(p.y - e.y, p.x - e.x);
    const dmg = 12 + n * 3 + this.endgame() * 4;
    const shoot = (ang: number, spd: number, r = 6) => this.shootBossProj(e.x, e.y, ang, spd, r, dmg, 16, null);
    // the safe gap in ring volleys: first one opens straight at the player,
    // then it walks ~40° around the circle per volley so the escape is always
    // reachable by following the pattern
    const nextGap = () => {
      if (bf.gapAng == null) bf.gapAng = baseA;
      else bf.gapAng += bf.gapDir * 0.7;
      return bf.gapAng;
    };
    const inGap = (ang: number, gapA: number, halfW: number) =>
      Math.abs(Math.atan2(Math.sin(ang - gapA), Math.cos(ang - gapA))) < halfW;
    if (pat === 'aimed') {
      const shots = 3 + Math.min(8, Math.floor(n * 0.7));
      const arc = 0.28;
      for (let i = 0; i < shots; i++) {
        const f = shots > 1 ? (i / (shots - 1) - 0.5) : 0;
        shoot(baseA + f * arc * shots, bf.speed * rand(0.95, 1.1));
      }
    } else if (pat === 'spiral') {
      const arms = 2 + Math.min(4, Math.floor(n / 2));
      for (let i = 0; i < arms; i++) shoot(bf.spin + (i / arms) * TAU, bf.speed * 0.9);
    } else if (pat === 'ring') {
      const count = 10 + Math.min(20, Math.floor(n * 1.5));
      const gapA = nextGap();
      const gapHalf = Math.max(0.25, 0.6 - n * 0.03); // safe gap tightens with boss count
      for (let i = 0; i < count; i++) {
        const ang = bf.spin + (i / count) * TAU;
        if (inGap(ang, gapA, gapHalf)) continue;
        shoot(ang, bf.speed * 0.85);
      }
    } else if (pat === 'cross') {
      for (let k = 0; k < 4; k++) {
        const base = bf.spin + k * (TAU / 4);
        for (let j = -1; j <= 1; j++) shoot(base + j * 0.12, bf.speed * 1.25);
      }
    } else if (pat === 'slam') {
      // Colossus: it plants itself and throws the ground outward — a slow,
      // heavy double ring of stones with one clear gap. Rooting the boss and
      // launching from the body's edge keeps the rings centred on the giant
      // that threw them (a walking origin read as the ring lagging behind).
      bf.hold = 1.1;
      this.shake = Math.min(10, this.shake + 6);
      audio.waveEvent();
      const count = 18 + Math.min(10, n);
      const gapA = nextGap();
      const gapHalf = Math.max(0.34, 0.55 - n * 0.02);
      const edge = e.radius * 0.7;
      for (let ring2 = 0; ring2 < 2; ring2++) {
        for (let i = 0; i < count; i++) {
          const ang = bf.spin + (i / count) * TAU + ring2 * (Math.PI / count);
          if (inGap(ang, gapA, gapHalf)) continue;
          // stones leave the hand slow, then gather speed as they travel —
          // near the boss the ring is readable, far out it bites
          const spd = bf.speed * (0.55 + ring2 * 0.2);
          this.shootBossProj(e.x + Math.cos(ang) * edge, e.y + Math.sin(ang) * edge, ang, spd, 9, dmg, 16, null, 65, spd * 3);
        }
      }
    } else if (pat === 'burst') {
      // Choir: a shrieking shotgun of quick shards aimed at the player
      const shots = 7 + Math.min(7, n);
      for (let i = 0; i < shots; i++) {
        shoot(baseA + rand(-0.45, 0.45), bf.speed * rand(1.05, 1.45), 5);
      }
    } else if (pat === 'gaze') {
      // Devourer: the eye narrows — three piercing lances loosed in a rapid
      // stream straight at you (staggered speeds so they arrive as a line)
      for (let i = 0; i < 3; i++) {
        shoot(baseA + rand(-0.04, 0.04), bf.speed * (1.7 + i * 0.18), 5);
      }
    } else if (pat === 'blink') {
      // Shade: it is not dashing — it is unstitched from here and restitched
      // there. The exit is chosen and marked NOW, so the vanishing act is a
      // promise the player can play against; updateBlink runs the wind-up,
      // the step, the unfold, and only then the spiteful greeting fan.
      const a3 = rand(0, TAU);
      bf.bx = p.x + Math.cos(a3) * 300;
      bf.by = p.y + Math.sin(a3) * 300;
      bf.blinkDur = BLINK_WINDUP;
      bf.blinkT = BLINK_WINDUP;
      bf.hold = BLINK_WINDUP + BLINK_IN + 0.2; // rooted through the whole act
      audio.bossBlink();
    } else if (pat === 'volley') {
      // Hollow Court: the crown of charge-orbs above its head discharges — each
      // orb looses a tight fan at the player, the whole crown converging from
      // slightly different heights so sidestepping one stream isn't enough
      const orbs = 5;
      for (let i = 0; i < orbs; i++) {
        const oa = bf.spin * 2.4 + (i / orbs) * TAU;
        const ox = e.x + Math.cos(oa) * e.radius * 0.85;
        const oy = e.y - e.radius * 1.2 + Math.sin(oa) * e.radius * 0.3;
        const aim = Math.atan2(p.y - oy, p.x - ox);
        for (let j = -1; j <= 1; j++) {
          this.shootBossProj(ox, oy, aim + j * 0.09, bf.speed * (1.0 + Math.abs(j) * 0.12), 6, dmg, 16, '#d98cff');
        }
      }
    } else if (pat === 'summon') {
      // Hollow Court: the king calls his retinue up through the floor
      if (this.enemies.length < 380) {
        audio.waveEvent();
        const adds = 3 + Math.min(4, n);
        for (let i = 0; i < adds; i++) {
          const m = this.spawnEnemy(this.pickType());
          if (!m) break;
          const a4 = rand(0, TAU);
          const R2 = e.radius + rand(50, 130);
          m.x = e.x + Math.cos(a4) * R2;
          m.y = e.y + Math.sin(a4) * R2;
          m.px = m.x; m.py = m.y;
          for (let k = 0; k < 8; k++) {
            this.particles.spawn({ x: m.x, y: m.y, vx: rand(-70, 70), vy: rand(-110, -20), life: rand(0.3, 0.7), size: rand(2, 5), color: '#d98cff', mode: 'glow', drag: 0.9 });
          }
        }
      }
      // and a light volley so the summon turn still threatens
      for (let i = -1; i <= 1; i++) shoot(baseA + i * 0.2, bf.speed * 0.9);
    }
  }

  // The Shade's step through the dark, staged so it never simply "is
  // elsewhere": night pours INTO the body while the exit iris is marked
  // (render draws the telegraph from bx/by), then a stitch of stars traces
  // the path it did not take, then the body unfolds — and only once it has
  // fully unfolded does the greeting fan fire, so the marked spot is dodgeable.
  // Returns true while any phase is running (the fire clock pauses).
  private updateBlink(e: Enemy, bf: BossFire, dt: number): boolean {
    if (bf.blinkT > 0) {
      bf.blinkT -= dt;
      // motes fall inward from a collapsing shell around the body
      for (let i = 0; i < 2; i++) {
        const a = rand(0, TAU);
        const r = e.radius * rand(1.5, 2.6);
        const lf = rand(0.16, 0.3);
        this.particles.spawn({
          x: e.x + Math.cos(a) * r, y: e.y + Math.sin(a) * r,
          vx: -Math.cos(a) * (r / lf), vy: -Math.sin(a) * (r / lf),
          life: lf, size: rand(2.5, 5), endSize: 0.5,
          color: '#8a7bff', color2: '#20123d', mode: 'spark',
        });
      }
      // faint stars rise where it will re-emerge
      if (Math.random() < 0.7) {
        const a = rand(0, TAU), r = rand(0, e.radius * 0.9);
        this.particles.spawn({ x: bf.bx + Math.cos(a) * r, y: bf.by + Math.sin(a) * r, vx: rand(-12, 12), vy: rand(-46, -16), life: rand(0.3, 0.6), size: rand(1.5, 3), color: '#b3a6ff', mode: 'star', rotV: rand(-4, 4), drag: 0.95 });
      }
      if (bf.blinkT <= 0) {
        // the step itself: night blooms at the entry, a seam of stars is
        // left along the path, and the body is simply at the exit
        const ox = e.x, oy = e.y;
        this.blinkVeil(ox, oy);
        const steps = 9;
        for (let i = 1; i < steps; i++) {
          const f = i / steps;
          this.particles.spawn({
            x: ox + (bf.bx - ox) * f + rand(-6, 6), y: oy + (bf.by - oy) * f + rand(-6, 6),
            vx: rand(-14, 14), vy: rand(-26, -6), life: rand(0.35, 0.7) + f * 0.15,
            size: rand(1.5, 3), color: '#cfc4ff', mode: 'star', rotV: rand(-5, 5), drag: 0.93,
          });
        }
        e.x = bf.bx; e.y = bf.by;
        e.px = e.x; e.py = e.y; // no interpolation streak across the screen
        this.blinkVeil(e.x, e.y);
        bf.blinkIn = BLINK_IN;
        audio.castVoid();
      }
      return true;
    }
    if (bf.blinkIn > 0) {
      bf.blinkIn -= dt;
      if (bf.blinkIn <= 0) {
        // fully unfolded — the spiteful fan greets you from the new angle
        const p = this.player;
        const na = Math.atan2(p.y - e.y, p.x - e.x);
        const dmg = 12 + this.bossCount * 3 + this.endgame() * 4;
        for (let i = 0; i < 6; i++) this.shootBossProj(e.x, e.y, na + (i - 2.5) * 0.14, bf.speed, 6, dmg, 16, null);
      }
      return true;
    }
    return false;
  }

  // night blooming at either end of a blink: dark smoke and a few pale stars
  private blinkVeil(x: number, y: number) {
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU);
      this.particles.spawn({ x, y, vx: Math.cos(a) * rand(40, 200), vy: Math.sin(a) * rand(40, 200), life: rand(0.3, 0.8), size: rand(4, 10), endSize: 1, color: '#8a7bff', color2: '#20123d', mode: 'smoke', drag: 0.9 });
    }
    for (let i = 0; i < 5; i++) {
      const a = rand(0, TAU);
      this.particles.spawn({ x, y, vx: Math.cos(a) * rand(30, 90), vy: Math.sin(a) * rand(30, 90) - 20, life: rand(0.4, 0.8), size: rand(2, 4), color: '#cfc4ff', mode: 'star', rotV: rand(-6, 6), drag: 0.92 });
    }
  }

  private updateSpawning(dt: number) {
    const w = this.wave;
    if (this.waveIdx !== w.idx) {
      this.waveIdx = w.idx;
      this.waveEventAt = this.t + rand(12, 30);
      this.waveEventDone = !w.event;
      const goldenChance = this.relics.has('cartographer') ? 1 : this.meta.golden ? 0.7 : 0.35;
      this.goldenAt = Math.random() < goldenChance ? this.t + rand(15, 40) : 0;
    }

    if (this.breather > 0) {
      this.breather -= dt;
    } else {
      this.spawnTimer -= dt;
      const alive = this.enemies.length;
      const esc = this.endgame();
      const escFloor = Math.floor(esc * esc * 2.2);
      // the director's hand: intensity swells the floor and quickens the tide
      // when the player is cruising, and eases both when they're drowning.
      // earlyEase() additionally softens the first-minutes ramp (a no-op past 7m).
      const ease = this.earlyEase();
      const floor = Math.round((w.floor + (this.meta.baneFloor || 0) + escFloor + this.pact.curseFloor) * this.intensity * ease);
      const rate = w.rate / (1 + (this.meta.baneRate || 0) / 100) / (1 + Math.min(2.5, esc * 0.2)) / this.intensity / ease;
      const cap = Math.min(420, 230 + escFloor);
      if (alive < floor && this.spawnTimer <= 0) {
        this.spawnTimer = Math.max(0.08, 0.2 - esc * 0.01);
        const n = Math.min(6 + Math.floor(esc * 1.5), floor - alive);
        for (let i = 0; i < n; i++) this.spawnEnemy(this.pickType());
      } else if (this.spawnTimer <= 0 && alive < cap) {
        this.spawnTimer = rate * rand(0.7, 1.3);
        const burst = 1 + ((Math.random() * 3) | 0) + Math.floor(esc * 0.6);
        for (let i = 0; i < burst; i++) this.spawnEnemy(this.pickType());
      }
      if (!this.waveEventDone && this.t >= this.waveEventAt) {
        this.waveEventDone = true;
        this.spawnEvent(w.event!);
      }
    }

    if (this.goldenAt && this.t >= this.goldenAt) {
      this.goldenAt = 0;
      this.spawnGolden();
    }

    this.eliteTimer -= dt;
    if (this.eliteTimer <= 0) {
      const esc = this.endgame();
      this.eliteTimer = Math.max(32, 50 - this.t / 40)
        / (1 + ((this.meta.baneElite || 0) + this.pact.curseElite) / 100)
        / (1 + Math.min(1.4, esc * 0.14)) // elites press harder the deeper the dream unravels
        / this.intensity;
      this.spawnEnemy(this.pickType(), true);
      // deep endgame: elites begin arriving in pairs so the CC-blanket always
      // has a resistant body it can't simply neutralise
      if (esc > 2 && Math.random() < Math.min(0.55, (esc - 2) * 0.11)) this.spawnEnemy(this.pickType(), true);
    }
    // nightmares arrive on the clock even if the last one still walks: a lone
    // boss can be outranged and kited forever, but two at once weave a bullet
    // hell that has to be fought, not fled
    if (this.bossTimer > 3 && this.bossTimer - dt <= 3) audio.bossOmen();
    this.bossTimer -= dt;
    if (this.bossTimer <= 0) {
      this.bossTimer = 160 / (1 + (this.meta.baneBoss || 0) / 100);
      this.bossCount++;
      this.spawnEnemy('eye', false, true);
    }
  }

  private spawnEvent(kind: string) {
    audio.waveEvent();
    const p = this.player;
    if (kind === 'ring') {
      this.setBanner('THE TIDE ENCIRCLES YOU', '#ff9ad5');
      const n = 22 + Math.min(18, (this.t / 30) | 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const e = this.spawnEnemy(this.pickType());
        if (!e) continue;
        e.x = p.x + Math.cos(a) * 560;
        e.y = p.y + Math.sin(a) * 560;
        e.px = e.x; e.py = e.y;
      }
    } else if (kind === 'wall') {
      this.setBanner('A WALL OF DREAMS ADVANCES', '#8a7bff');
      const a = rand(0, TAU);
      const nx = Math.cos(a), ny = Math.sin(a);
      for (let i = 0; i < 26; i++) {
        const off = (i - 13) * 55;
        const e = this.spawnEnemy(this.pickType());
        if (!e) continue;
        e.x = p.x + nx * 700 - ny * off;
        e.y = p.y + ny * 700 + nx * off;
        e.px = e.x; e.py = e.y;
      }
    } else if (kind === 'pack') {
      this.setBanner('AN ELITE PACK STIRS', '#ffd27a');
      const a = rand(0, TAU);
      const cx = p.x + Math.cos(a) * 620, cy = p.y + Math.sin(a) * 620;
      const elite = this.spawnEnemy(this.pickType(), true);
      if (elite) { elite.x = cx; elite.y = cy; elite.px = cx; elite.py = cy; }
      for (let i = 0; i < 8; i++) {
        const e = this.spawnEnemy(this.pickType());
        if (!e) continue;
        e.x = cx + rand(-90, 90);
        e.y = cy + rand(-90, 90);
        e.px = e.x; e.py = e.y;
      }
    }
  }

  private spawnGolden() {
    if (this.freeSlots.length === 0) return;
    const d = this.diff;
    const a = rand(0, TAU);
    // the golden wisp flits into view rather than lurking off-screen: it spawns
    // on the visible field, out near the rim, so the player can spot and chase it
    const pt = this.visibleEdgePoint(a, 0.6, 0.9, 60);
    const e = this.enemyPool.acquire();
    e.uid = this.uidCounter++;
    e.slot = this.freeSlots.pop()!;
    e.type = 'wisp';
    e.golden = true;
    e.boss = false;
    e.elite = false;
    e.dead = false;
    e.x = pt.x;
    e.y = pt.y;
    e.px = e.x; e.py = e.y;
    e.hp = 70 * d.hpMul; e.maxHp = 70 * d.hpMul;
    e.speed = 150; e.dmg = 0; e.radius = 14; e.xp = 4; e.color = '#ffd27a';
    e.slow = 0; e.slowT = 0; e.hitFlash = 0;
    e.ccSat = 0; e.ccImmT = 0; e.rageT = 0;
    e.chargeT = 0; e.chargeDmg = 0; e.brandT = 0; e.reactCd = 0;
    e.nbT = 0; e.nbDps = 0; e.nbPct = 0; e.nbTick = 0; e.nbAmp = 0; e.nbSpread = false; e.nbBurst = 0;
    e.animT = Math.random() * 10;
    e.seed = Math.random() * 1000;
    e.knbx = 0; e.knby = 0; e.goldT = 12;
    e.shootCd = -1; e.dmgTextT = 0; e.ranged = null; e.bossFire = null;
    e.meleeCd = Infinity; e.meleeBaseCd = Infinity; e.meleeReach = 0; e.meleeAnim = 0;
    this.enemies.push(e);
    audio.goldenWisp();
    this.setBanner('A GOLDEN WISP FLITS PAST', '#ffd27a');
  }

  // -------------------------------------------------------------- targeting
  viewRect(margin = 0) {
    const { x, y, w, h } = this.cam;
    const r = this.viewOut;
    r.left = x - margin; r.right = x + w + margin; r.top = y - margin; r.bottom = y + h + margin;
    return r;
  }

  inView(x: number, y: number, margin = 0) {
    const r = this.viewRect(margin);
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  clampToView(x: number, y: number, inset = 40) {
    const r = this.viewRect(-inset);
    this.clampOut.x = clamp(x, r.left, r.right);
    this.clampOut.y = clamp(y, r.top, r.bottom);
    return this.clampOut;
  }

  visibleEnemies(): Enemy[] {
    if (this.visT === this.t) return this.visCache;
    const arr = this.visCache;
    arr.length = 0;
    const { x, y, w, h } = this.cam;
    const left = x, right = x + w, top = y, bottom = y + h;
    const en = this.enemies;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (!e.dead && e.x >= left && e.x <= right && e.y >= top && e.y <= bottom) arr.push(e);
    }
    this.visT = this.t;
    return arr;
  }

  nearestEnemy(x: number, y: number, maxR = Infinity, exclude: Enemy | null = null, preferBoss = false): Enemy | null {
    let best: Enemy | null = null, bd = maxR * maxR;
    let boss: Enemy | null = null, bossD = Infinity;
    const halfScreen = Math.max(this.cam.w, this.cam.h) * 0.5;
    const bossRange = halfScreen * halfScreen;
    const { left, right, top, bottom } = this.viewRect(0);
    for (const e of this.enemies) {
      if (e === exclude || e.dead) continue;
      if (e.x < left || e.x > right || e.y < top || e.y > bottom) continue;
      const d = dist2(x, y, e.x, e.y);
      if (preferBoss && e.boss && d < bossRange) {
        if (d < bossD) { bossD = d; boss = e; }
      }
      if (d < bd) { bd = d; best = e; }
    }
    if (preferBoss && boss) return boss;
    return best;
  }

  // Single-target picker: the nearest foe, but bosses, golden wisps and elites
  // pull their effective distance in so spells snap to the real threats instead
  // of chipping the fodder around them (see TARGET_PRI_* for the weights).
  pickTarget(x: number, y: number, maxR = Infinity): Enemy | null {
    const { left, right, top, bottom } = this.viewRect(0);
    const maxR2 = maxR * maxR;
    let best: Enemy | null = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.x < left || e.x > right || e.y < top || e.y > bottom) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d > maxR2) continue;
      const pri = e.boss ? TARGET_PRI_BOSS : e.golden ? TARGET_PRI_GOLDEN : e.elite ? TARGET_PRI_ELITE : 1;
      const score = d / pri;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  densestPoint(radius: number): { x: number; y: number } | null {
    const vis = this.visibleEnemies();
    if (!vis.length) return null;
    let cand: Enemy[] = vis;
    if (cand.length > 70) {
      cand = this.densCand;
      cand.length = 0;
      for (let i = 0; i < 70; i++) cand.push(vis[(Math.random() * vis.length) | 0]);
    }
    const r2 = radius * radius;
    let best: Enemy | null = null, bestScore = -1;
    for (const e of cand) {
      let score = 0;
      for (const o of vis) {
        if (dist2(e.x, e.y, o.x, o.y) < r2) score += o.boss ? 4 : o.golden ? 3 : o.elite ? 2.5 : 1;
      }
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (!best) return null;
    this.densOut.x = best.x;
    this.densOut.y = best.y;
    return this.densOut;
  }

  // -------------------------------------------------------------- spells
  private castSpells(dt: number) {
    const p = this.player;
    const visible = this.visibleEnemies().length > 0;
    for (const s of p.spells) {
      if (CONTINUOUS.has(s.id)) continue; // petals orbit, wisps hover, the wake is walked
      s.cd -= dt;
      if (s.cd > 0) continue;
      if (!visible) { s.cd = 0.05; continue; }
      const st = this.spellStats(s.id, s.level, s.mastery || 0);
      st.evolved = !!s.evolved;
      s.cd = Math.max(0.12, st.cooldown * this.cdMul());
      this.cast(s.id, st);
      if (this.meta.echo && Math.random() < this.meta.echo / 100) this.cast(s.id, st);
    }
    this.updateOrbitals(dt);
    this.updateFrostOrbs(dt);
    this.updateWisps(dt);
    this.updateDefense(dt);
  }

  // Somnal Ward (an absorb pool that mends) and Hush (a drowsy slow-veil that
  // sighs the horde back). Both are purely defensive — no damage is ever dealt.
  private updateDefense(dt: number) {
    const p = this.player;

    // ---- Somnal Ward: mend the glass, spin the panes
    const ward = p.spells.find((s) => s.id === 'ward');
    if (ward) {
      const st = this.spellStats('ward', ward.level, ward.mastery || 0);
      p.shieldMax = st.shield!;
      p.shieldDelay = st.rechargeDelay!;
      p.shieldPh += dt * 0.9;
      const rechargeMul = ward.evolved ? 2 : 1;
      if (p.shield > p.shieldMax) p.shield = p.shieldMax; // a level-down clamp
      if (p.shieldT > 0) {
        p.shieldT = Math.max(0, p.shieldT - dt);
      } else if (p.shield < p.shieldMax) {
        p.shield = Math.min(p.shieldMax, p.shield + st.recharge! * rechargeMul * dt);
      }
    } else {
      p.shieldMax = 0; p.shield = 0; p.shieldT = 0;
    }

    // ---- Hush: hold everything inside the veil, and sigh on the beat
    const hush = p.spells.find((s) => s.id === 'hush');
    if (hush) {
      const st = this.spellStats('hush', hush.level, hush.mastery || 0);
      const R = st.radius! * this.aoeMul();
      const evolved = !!hush.evolved;
      const slow = evolved ? Math.max(0.9, st.slow!) : st.slow!;
      const R2 = R * R;
      // constant drowse: bosses shrug it off (bane balance), everything else
      // grows heavy-limbed while it lingers inside
      this.grid.queryCircle(p.x, p.y, R, (e) => {
        if (e.boss || e.dead) return;
        if (dist2(p.x, p.y, e.x, e.y) < R2) {
          if (e.slow < slow) e.slow = slow;
          e.slowT = Math.max(e.slowT, st.slowDur!);
        }
      });
      // Deep Hush: the dreamer mends while standing within their own quiet
      if (evolved && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + 2 * dt); // 2 life/sec, smooth
      }
      // a slow drift of dream-motes marking the veil's edge
      if (Math.random() < 0.5) {
        const a = rand(0, TAU);
        this.particles.spawn({ x: p.x + Math.cos(a) * R * rand(0.85, 1), y: p.y + Math.sin(a) * R * rand(0.85, 1), vx: -Math.sin(a) * 14, vy: Math.cos(a) * 14 - 10, life: rand(0.7, 1.4), size: rand(1.5, 3), color: pick(['#b7a7ff', '#e9dcff', '#cabaff']), mode: 'glow', drag: 0.98 });
      }
      // the sigh: a gentle pulse shoving the horde back out to the veil's edge
      p.hushT -= dt;
      if (p.hushT <= 0) {
        p.hushT = st.interval!;
        audio.hushSigh(this.panOf(p.x));
        const stun = !!st.special!.stun;
        this.grid.queryCircle(p.x, p.y, R, (e) => {
          if (e.boss || e.dead) return;
          const dd = dist2(p.x, p.y, e.x, e.y);
          if (dd < R2 && dd > 1) {
            const D = Math.sqrt(dd);
            if (this.hardCC(e, stun ? CC_HIT : CC_HIT * 0.5)) {
              e.knbx += ((e.x - p.x) / D) * st.knock!;
              e.knby += ((e.y - p.y) / D) * st.knock!;
              if (stun) { e.slow = Math.max(e.slow, 0.9); e.slowT = Math.max(e.slowT, 0.5); }
            }
          }
        });
        this.particles.spawn({ x: p.x, y: p.y, life: 0.5, size: R * 1.05, color: 'rgba(183,167,255,0.4)', mode: 'ring' });
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU;
          this.particles.spawn({ x: p.x + Math.cos(a) * 12, y: p.y + Math.sin(a) * 12, vx: Math.cos(a) * rand(120, R * 1.8), vy: Math.sin(a) * rand(120, R * 1.8), life: rand(0.3, 0.6), size: rand(2, 5), endSize: 0.5, color: '#e9dcff', color2: '#b7a7ff', mode: 'glow', drag: 0.9 });
        }
      }
    } else {
      p.hushT = 0;
    }
  }

  // the Somnal Ward breaking: no damage — it hurls the horde outward, unmakes
  // enemy shots caught in the burst, and (evolved) veils the dreamer for a beat
  private wardShatter() {
    const p = this.player;
    const ward = p.spells.find((s) => s.id === 'ward');
    if (!ward) return;
    const st = this.spellStats('ward', ward.level, ward.mastery || 0);
    const R = st.radius! * this.aoeMul();
    const R2 = R * R;
    const evolved = !!ward.evolved;
    const bossKnock = !!st.special!.bossKnock;
    audio.wardBreak(this.panOf(p.x));
    this.shake = Math.min(10, this.shake + 6);
    this.flash = { color: '143,184,255', a: 0.42 };
    this.grid.queryCircle(p.x, p.y, R, (e) => {
      if (e.dead) return;
      if (e.boss && !bossKnock) return;
      const dd = dist2(p.x, p.y, e.x, e.y);
      if (dd < R2) {
        const a = dd > 1 ? Math.atan2(e.y - p.y, e.x - p.x) : rand(0, TAU);
        const k = st.knock! * (e.boss ? 0.4 : 1);
        if (this.hardCC(e, CC_HIT)) { e.knbx += Math.cos(a) * k; e.knby += Math.sin(a) * k; }
      }
    });
    // unmake enemy bullets swept up in the shatter (evolved reaches full radius,
    // the base ward only clears the shards right around the dreamer)
    const bulletR2 = evolved ? R2 : (R * 0.6) ** 2;
    for (const bp of this.bossProjectiles) {
      if (bp.life <= 0 || bp.reflected) continue;
      if (dist2(p.x, p.y, bp.x, bp.y) < bulletR2) {
        bp.life = 0;
        this.particles.spawn({ x: bp.x, y: bp.y, life: 0.24, size: bp.r * 3.2, endSize: 1, color: '#ffffff', color2: '#8fb8ff', mode: 'glow', drag: 1 });
      }
    }
    if (evolved) {
      p.invuln = Math.max(p.invuln, 1.2);
      this.spawnText(p.x, p.y - 60, 'AEGIS', '#8fb8ff', 1.4, -22, 18);
    }
    // the glass flying apart: twin bright rings and a heavier spray of pale shards
    this.particles.spawn({ x: p.x, y: p.y - 14, life: 0.5, size: R * 1.1, color: '#e6f0ff', mode: 'ring' });
    this.particles.spawn({ x: p.x, y: p.y - 14, life: 0.35, size: R * 0.78, color: '#bcd6ff', mode: 'ring' });
    this.particles.spawn({ x: p.x, y: p.y - 14, life: 0.22, size: 46, endSize: 4, color: '#ffffff', color2: '#8fb8ff', mode: 'glow', drag: 1 });
    for (let k = 0; k < 46; k++) {
      const a = rand(0, TAU);
      this.particles.spawn({ x: p.x + Math.cos(a) * 16, y: p.y - 14 + Math.sin(a) * 16, vx: Math.cos(a) * rand(180, 520), vy: Math.sin(a) * rand(180, 520), life: rand(0.35, 0.85), size: rand(3, 7.5), endSize: 0.5, color: Math.random() < 0.5 ? '#e6f0ff' : '#8fb8ff', mode: 'shard', rotV: rand(-10, 10), drag: 0.87 });
    }
  }

  // where the player stood `secondsAgo` seconds ago (shared out-object)
  private histAt(secondsAgo: number) {
    const steps = Math.min(HIST_N - 1, Math.max(0, Math.round(secondsAgo / STEP)));
    const idx = (this.histI - steps + HIST_N * 2) & (HIST_N - 1);
    this.histOut.x = this.histX[idx];
    this.histOut.y = this.histY[idx];
    return this.histOut;
  }

  rebuildWisps() {
    const s = this.player.spells.find((s) => s.id === 'wisps');
    const st = s ? this.spellStats('wisps', s.level, s.mastery || 0) : null;
    const n = st ? st.count! + (this.meta.extraCount || 0) : 0;
    while (this.wisps.length > n) this.wisps.pop();
    while (this.wisps.length < n) {
      const p = this.player;
      this.wisps.push({
        x: p.x, y: p.y - 24, px: p.x, py: p.y - 24,
        cd: rand(0.3, 1.4), state: 0, dartT: 0, sx: 0, sy: 0,
        target: null, targetUid: 0, delay: 0, seed: rand(0, 1000),
      });
    }
    this.wisps.forEach((w, i) => { w.delay = 0.3 + i * 0.16; });
  }

  // the Wisp Choir: each wisp hovers over the player's trail, darts at a foe
  // in range on its own cadence, then drifts home along the procession
  private updateWisps(dt: number) {
    if (!this.wisps.length) return;
    const s = this.player.spells.find((s) => s.id === 'wisps');
    if (!s) { this.wisps.length = 0; return; }
    const st = this.spellStats('wisps', s.level, s.mastery || 0);
    const haste = 1 + (st.special!.dartHaste || 0) / 100;
    const dartCd = (st.cooldown * this.cdMul()) / haste;
    const range = st.range! * (1 + (st.special!.dartHaste || 0) / 200);
    const dmg = st.damage! * this.dmgMul();
    for (const w of this.wisps) {
      w.px = w.x; w.py = w.y;
      const home = this.histAt(w.delay);
      const hx = home.x + Math.sin(this.t * 2.1 + w.seed) * 9;
      const hy = home.y - 26 + Math.sin(this.t * 3.3 + w.seed) * 6;
      if (w.state === 0) {
        w.x += (hx - w.x) * Math.min(1, dt * 9);
        w.y += (hy - w.y) * Math.min(1, dt * 9);
        w.cd -= dt;
        if (w.cd <= 0) {
          const t = this.pickTarget(w.x, w.y, range);
          if (t) this.wispDart(w, t);
          else w.cd = 0.2;
        }
      } else if (w.state === 1) {
        w.dartT -= dt;
        const tgt = w.target;
        if (!tgt || tgt.dead || tgt.uid !== w.targetUid) {
          w.state = 2; w.dartT = 0.3; w.target = null;
        } else {
          const f = 1 - Math.max(0, w.dartT) / 0.16;
          w.x = w.sx + (tgt.x - w.sx) * f * f;
          w.y = w.sy + (tgt.y - w.sy) * f * f;
          if (Math.random() < 0.8) this.particles.spawn({ x: w.x, y: w.y, vx: rand(-15, 15), vy: rand(-15, 15), life: 0.3, size: rand(2, 4.5), endSize: 0.5, color: '#8cf7e2', color2: '#eafffb', mode: 'glow' });
          if (w.dartT <= 0) {
            this.damageEnemy(tgt, dmg, '#8cf7e2');
            audio.wispDart(this.panOf(w.x));
            for (let k = 0; k < 7; k++) this.particles.spawn({ x: w.x, y: w.y, vx: rand(-150, 150), vy: rand(-150, 150), life: rand(0.2, 0.45), size: rand(2, 4), color: '#8cf7e2', mode: 'star', rotV: rand(-6, 6), drag: 0.86 });
            w.state = 2; w.dartT = 0.3;
            w.cd = dartCd * rand(0.9, 1.1);
            this.wispDarts++;
            // Choir Eternal: every eighth dart the whole choir strikes as one
            if (s.evolved && this.wispDarts % 8 === 0 && !tgt.dead) {
              for (const o of this.wisps) {
                if (o !== w && o.state === 0) this.wispDart(o, tgt);
              }
            }
          }
        }
      } else {
        w.dartT -= dt;
        w.x += (hx - w.x) * Math.min(1, dt * 5);
        w.y += (hy - w.y) * Math.min(1, dt * 5);
        if (w.dartT <= 0) w.state = 0;
      }
      if (Math.random() < 0.25) this.particles.spawn({ x: w.x, y: w.y + 4, vx: rand(-8, 8), vy: rand(-26, -8), life: rand(0.3, 0.7), size: rand(1.5, 3), color: Math.random() < 0.5 ? '#8cf7e2' : '#eafffb', mode: 'glow', drag: 0.95 });
    }
  }

  private wispDart(w: Wisp, target: Enemy) {
    w.state = 1;
    w.dartT = 0.16;
    w.sx = w.x; w.sy = w.y;
    w.target = target;
    w.targetUid = target.uid;
  }

  private newProj(kind: Projectile['kind']): Projectile {
    const pr = this.projPool.acquire();
    pr.kind = kind;
    pr.dead = false;
    pr.target = null;
    pr.targetUid = 0;
    pr.splinter = false;
    pr.pierce = 0;
    pr.struckA = -1;
    pr.struckB = -1;
    pr.hasX0 = false;
    pr.stun = false;
    pr.hasBurn = false;
    pr.hit = null;
    pr.chill = false;
    pr.returning = false;
    pr.travelled = 0;
    pr.spin = 0;
    pr.hitCd = null;
    pr.evolved = false;
    pr.t = 0;
    return pr;
  }

  // assign a homing target together with its uid (see Projectile.targetUid)
  private setProjTarget(pr: Projectile, e: Enemy | null) {
    pr.target = e;
    pr.targetUid = e ? e.uid : 0;
  }

  // stereo position of a world x for audio: the player is always screen-centre
  private panOf(x: number) {
    return clamp((x - this.player.x) / 900, -0.8, 0.8);
  }

  private cast(id: string, st: SpellStats) {
    const p = this.player;
    p.castPulse = 1;
    // Stormcrown: every fifth cast calls a charged bolt on the nearest foe
    if (this.relics.has('stormcrown') && ++this.castCounter % 5 === 0) {
      const t = this.nearestEnemy(p.x, p.y, 620);
      if (t) {
        this.spawnBolt(p.x, p.y - 34, t.x, t.y);
        this.damageEnemy(t, (25 + p.level * 6) * this.dmgMul(), '#bfeaff', 'storm');
      }
    }
    switch (id) {
      case 'arcane': {
        const target = this.pickTarget(p.x, p.y, 640);
        for (let i = 0; i < st.count! + (this.meta.extraCount || 0); i++) {
          const baseA = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
          const a = baseA + rand(-0.7, 0.7);
          const pr = this.newProj('arcane');
          pr.x = p.x; pr.y = p.y - 26; pr.px = pr.x; pr.py = pr.y;
          pr.vx = Math.cos(a) * st.speed! * 0.5;
          pr.vy = Math.sin(a) * st.speed! * 0.5;
          pr.speed = st.speed!;
          pr.dmg = st.damage! * this.dmgMul();
          pr.life = 2.6; pr.r = 7;
          pr.turn = st.special!.seek ? 10.5 : 7.5;
          this.setProjTarget(pr, target);
          pr.splinter = !!st.evolved;
          pr.pierce = st.special!.pierce || 0;
          this.projectiles.push(pr);
        }
        audio.castArcane(rand(-0.4, 0.4));
        break;
      }
      case 'ember': {
        const blastR = st.radius! * this.aoeMul();
        const cluster = this.densestPoint(blastR);
        const cx = cluster ? cluster.x : 0, cy = cluster ? cluster.y : 0;
        for (let i = 0; i < st.count! + (this.meta.extraCount || 0); i++) {
          const spread = i === 0 ? 20 : blastR * (st.special!.carpet ? 0.5 : 0.9);
          const { x: tx, y: ty } = this.clampToView(
            cluster ? cx + rand(-spread, spread) : p.x + rand(-260, 260),
            cluster ? cy + rand(-spread, spread) : p.y + rand(-260, 260),
          );
          const flight = rand(0.55, 0.8);
          const burnPct = (st.evolved ? 40 : 0) + (st.special!.burn || 0);
          const pr = this.newProj('ember');
          pr.x = p.x; pr.y = p.y - 30; pr.px = pr.x; pr.py = pr.y;
          pr.sx = p.x; pr.sy = p.y - 30; pr.tx = tx; pr.ty = ty;
          pr.t = 0; pr.dur = flight; pr.arc = rand(70, 150);
          pr.dmg = st.damage! * this.dmgMul();
          pr.range = st.radius! * this.aoeMul(); // blast radius stored in range
          pr.r = 9;
          pr.life = 1;
          if (burnPct) {
            pr.hasBurn = true;
            pr.burnC1 = '#ff8c5a'; pr.burnC2 = '#ffd27a';
            pr.burnDps = st.damage! * this.dmgMul() * burnPct / 100;
          }
          this.projectiles.push(pr);
        }
        audio.castEmber();
        break;
      }
      case 'storm': {
        const first = this.pickTarget(p.x, p.y, st.range!);
        if (!first) return;
        audio.castStorm();
        let fromX = p.x, fromY = p.y - 34;
        let cur: Enemy | null = first;
        const hitSet = this.stormMask.begin();
        const chains = st.chains! + (st.evolved ? 3 : 0);
        const falloff = Math.min(0.96, (st.evolved ? 0.92 : 0.85) + (st.special!.falloff ? 0.06 : 0));
        for (let c = 0; c <= chains && cur; c++) {
          this.spawnBolt(fromX, fromY, cur.x, cur.y);
          this.damageEnemy(cur, st.damage! * this.dmgMul() * Math.pow(falloff, c), '#bfeaff', 'storm');
          hitSet.mark(cur.slot);
          for (let i = 0; i < 10; i++) this.particles.spawn({ x: cur.x, y: cur.y, vx: rand(-160, 160), vy: rand(-160, 160), life: rand(0.15, 0.4), size: rand(2, 4), color: '#dff4ff', mode: 'spark', drag: 0.85 });
          fromX = cur.x; fromY = cur.y;
          cur = null;
          let bd = 240 * 240;
          const { left, right, top, bottom } = this.viewRect(0);
          for (const e of this.enemies) {
            if (hitSet.has(e.slot) || e.dead) continue;
            if (e.x < left || e.x > right || e.y < top || e.y > bottom) continue;
            const d = dist2(fromX, fromY, e.x, e.y);
            if (d < bd) { bd = d; cur = e; }
          }
        }
        break;
      }
      case 'void': {
        const riftR = st.radius! * this.aoeMul();
        const pt = this.densestPoint(riftR * 1.4);
        let tx = pt ? pt.x : p.x + rand(-220, 220);
        let ty = pt ? pt.y : p.y + rand(-220, 220);
        // Keep the rift a minimum distance from the player, scaled with its AoE,
        // so the pull vortex is never dumped on top of the player — otherwise it
        // can drag enemies straight through the player to reach the centre. If
        // the target is too close, shove it radially outward to the min ring.
        const minDist = riftR + PLAYER_HURT_R + 60;
        const dx = tx - p.x, dy = ty - p.y;
        const d = Math.hypot(dx, dy);
        if (d < minDist) {
          const a = d > 0.01 ? Math.atan2(dy, dx) : rand(0, TAU);
          tx = p.x + Math.cos(a) * minDist;
          ty = p.y + Math.sin(a) * minDist;
        }
        const { x: bx, y: by } = this.clampToView(tx, ty);
        audio.castVoid();
        const z = this.zonePool.acquire();
        this.resetZone(z, 'rift', bx, by);
        z.r = riftR; z.pr = riftR;
        z.life = st.duration!; z.maxLife = st.duration!;
        z.dps = st.dps! * this.dmgMul();
        z.pull = st.pull!;
        z.tick = 0;
        z.spin = rand(0, TAU);
        z.evolved = !!st.evolved;
        z.bossPull = !!st.special!.bossPull;
        this.zones.push(z);
        break;
      }
      case 'moon': {
        audio.castMoon();
        const target = this.pickTarget(p.x, p.y, 800);
        const a = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        const beamLife = st.evolved ? 0.75 : 0.5;
        for (let b = 0; b < st.beams!; b++) {
          const ang = a + b * Math.PI;
          const bm = this.beamPool.acquire();
          bm.dead = false;
          bm.kind = 'lance';
          bm.x = p.x; bm.y = p.y - 20;
          bm.a = ang; bm.pa = ang;
          bm.len = st.length!; bm.w = st.width!;
          bm.life = beamLife; bm.maxLife = beamLife;
          bm.dmg = st.damage! * this.dmgMul();
          bm.hit = maskPool.acquire().begin();
          bm.hitT = null; bm.follow = false; bm.stun = false; bm.linger = false;
          bm.sweep = st.evolved ? (b % 2 ? 1 : -1) * 2.0 : 0;
          this.beams.push(bm);
        }
        break;
      }
      case 'starfall': {
        audio.castStarfall();
        const count = st.count! + (this.meta.extraCount || 0);
        const blastR = st.radius! * this.aoeMul();
        const cluster = this.densestPoint(blastR);
        const cx = cluster ? cluster.x : 0, cy = cluster ? cluster.y : 0;
        for (let i = 0; i < count; i++) {
          const spread = i === 0 ? 16 : blastR * 0.9;
          const { x: tx, y: ty } = this.clampToView(
            cluster ? cx + rand(-spread, spread) : p.x + rand(-300, 300),
            cluster ? cy + rand(-spread, spread) : p.y + rand(-300, 300),
          );
          const pr = this.newProj('comet');
          pr.tx = tx; pr.ty = ty;
          pr.x = tx + rand(-140, -60); pr.y = ty - 560;
          pr.px = pr.x; pr.py = pr.y;
          pr.t = 0; pr.dur = rand(0.5, 0.7);
          pr.dmg = st.damage! * this.dmgMul();
          pr.range = st.radius! * this.aoeMul();
          pr.life = 1;
          pr.stun = !!st.special!.stun;
          if (st.evolved) {
            pr.hasBurn = true;
            pr.burnC1 = '#ffb3f2'; pr.burnC2 = '#8a7bff';
            pr.burnDps = st.damage! * this.dmgMul() * 0.35;
          }
          this.projectiles.push(pr);
        }
        break;
      }
      case 'umbra': {
        audio.castUmbra();
        const count = st.count! + (this.meta.extraCount || 0) + (st.evolved ? 2 : 0);
        const target = this.pickTarget(p.x, p.y, 640);
        const baseA = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        for (let i = 0; i < count; i++) {
          const a = baseA + (i - (count - 1) / 2) * 0.22;
          const pr = this.newProj('fang');
          pr.x = p.x; pr.y = p.y - 18; pr.px = pr.x; pr.py = pr.y;
          pr.vx = Math.cos(a) * st.speed!;
          pr.vy = Math.sin(a) * st.speed!;
          pr.dmg = st.damage! * this.dmgMul() * (st.evolved ? 1.5 : 1);
          pr.life = 1.5;
          pr.r = 12 * (st.special!.big ? 1.4 : 1);
          pr.hit = maskPool.acquire().begin();
          pr.chill = !!st.special!.chill;
          this.projectiles.push(pr);
        }
        break;
      }
      case 'glaive': {
        audio.castGlaive();
        const count = st.count! + (this.meta.extraCount || 0);
        const target = this.pickTarget(p.x, p.y, 700);
        const baseA = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        for (let i = 0; i < count; i++) {
          const a = baseA + i * (TAU / Math.max(2, count * 2));
          const pr = this.newProj('glaive');
          pr.x = p.x; pr.y = p.y - 20; pr.px = pr.x; pr.py = pr.y;
          pr.a = a;
          pr.travelled = 0; pr.range = st.range!; pr.speed = st.speed!;
          pr.returning = false;
          pr.dmg = st.damage! * this.dmgMul();
          pr.life = 6; pr.r = 14; pr.spin = 0;
          pr.hitCd = timerPool.acquire().begin();
          pr.hitInt = st.special!.fastHit ? 0.28 : 0.45;
          pr.evolved = !!st.evolved;
          this.projectiles.push(pr);
        }
        break;
      }
      case 'nebula': {
        audio.castNebula();
        const cloudR = st.radius! * this.aoeMul() * (st.evolved ? 1.25 : 1);
        const pt = this.densestPoint(cloudR);
        const { x: bx, y: by } = this.clampToView(pt ? pt.x : p.x + rand(-220, 220), pt ? pt.y : p.y + rand(-220, 220));
        const driftA = rand(0, TAU);
        const z = this.zonePool.acquire();
        this.resetZone(z, 'nebula', bx, by);
        z.r = cloudR; z.pr = cloudR;
        z.life = st.duration!; z.maxLife = st.duration!;
        z.dps = st.dps! * this.dmgMul();
        z.tick = 0;
        z.dvx = Math.cos(driftA) * 16; z.dvy = Math.sin(driftA) * 16;
        z.seed = rand(0, TAU);
        z.evolved = !!st.evolved;
        z.slowIn = st.special!.slowIn || 0;
        z.core = !!st.special!.core;
        this.zones.push(z);
        break;
      }
      case 'sigil': {
        audio.castSigil();
        const sigR = st.radius! * this.aoeMul();
        const pt = this.densestPoint(sigR);
        const { x: bx, y: by } = this.clampToView(pt ? pt.x : p.x + rand(-200, 200), pt ? pt.y : p.y + rand(-200, 200));
        const armT = st.special!.armFast ? 0.72 : 1.1;
        const z = this.zonePool.acquire();
        this.resetZone(z, 'sigil', bx, by);
        z.r = sigR; z.pr = sigR;
        z.life = armT; z.maxLife = armT;
        z.dmg = st.damage! * this.dmgMul();
        z.sleepDur = st.sleepDur!;
        z.echo = !!st.evolved;
        this.zones.push(z);
        break;
      }
      case 'lantern': {
        audio.castLantern();
        const count = st.count! + (this.meta.extraCount || 0);
        const R = st.radius! * this.aoeMul();
        const dur = st.duration! * (st.evolved ? 1.5 : 1);
        const cluster = this.densestPoint(R);
        const cx = cluster ? cluster.x : 0, cy = cluster ? cluster.y : 0;
        for (let i = 0; i < count; i++) {
          const spread = i === 0 ? 14 : R * 1.1;
          const { x: bx, y: by } = this.clampToView(
            cluster ? cx + rand(-spread, spread) : p.x + rand(-220, 220),
            cluster ? cy + rand(-spread, spread) : p.y + rand(-220, 220),
          );
          const z = this.zonePool.acquire();
          this.resetZone(z, 'lantern', bx, by);
          z.r = R; z.pr = R;
          z.life = dur; z.maxLife = dur;
          z.dmg = st.damage! * this.dmgMul();
          z.tick = 0.4;
          z.int = st.evolved ? 0.4 : 0.8;
          z.heal = st.special!.heal || 0;
          z.ph = rand(0, TAU);
          this.zones.push(z);
        }
        break;
      }
      case 'nova': {
        audio.castNova();
        const R = st.radius! * this.aoeMul();
        const mk = (maxR: number, dmg: number, knock: number, delay: number) => {
          const z = this.zonePool.acquire();
          this.resetZone(z, 'novawave', p.x, p.y);
          z.r = 10; z.pr = 10; z.maxR = maxR;
          z.life = 0.5; z.maxLife = 0.5;
          z.delay = delay;
          z.dmg = dmg; z.knock = knock;
          z.hit = maskPool.acquire().begin();
          z.dissolve = st.special!.dissolve || 0;
          this.zones.push(z);
        };
        mk(R, st.damage! * this.dmgMul(), st.knock!, 0);
        // Endless Dusk: a second wave follows the first
        if (st.evolved) mk(R * 1.1, st.damage! * this.dmgMul() * 0.7, st.knock! * 0.7, 0.35);
        for (let i = 0; i < 50; i++) {
          const a = rand(0, TAU);
          this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(160, R * 2.2), vy: Math.sin(a) * rand(160, R * 2.2), life: rand(0.3, 0.7), size: rand(3, 7), endSize: 1, color: '#ff9ad5', color2: '#5a2a6e', mode: 'glow', drag: 0.87 });
        }
        break;
      }
      case 'serpent': {
        audio.castSerpent();
        // aim it at the thickest shoal so it starts swimming into the crowd
        const pt = this.densestPoint(200);
        const a = pt ? Math.atan2(pt.y - p.y, pt.x - p.x) : rand(0, TAU);
        const z = this.zonePool.acquire();
        this.resetZone(z, 'serpent', p.x + Math.cos(a) * 70, p.y + Math.sin(a) * 70);
        // AoE feeds the serpent's length, barely its girth — stacked AoE makes
        // a long serpent, not a fat one
        const aoe = this.aoeMul();
        z.r = st.radius! * (1 + (aoe - 1) * 0.25); z.pr = z.r;
        z.maxR = st.length! * (1 + (st.special!.longer || 0) / 100) * (1 + (aoe - 1) * 1.35); // body length behind the head
        z.life = st.duration!; z.maxLife = st.duration!;
        z.dps = st.dps! * this.dmgMul();
        z.spin = a;                 // heading
        z.knock = st.speed!;        // swim speed
        z.grow = 1;
        z.tick = 0.1; z.tick2 = 0;
        z.ox = pt ? pt.x : p.x + Math.cos(a) * 300;
        z.oy = pt ? pt.y : p.y + Math.sin(a) * 300;
        z.evolved = !!st.evolved;
        z.core = !!st.special!.feed; // Salt Hunger: kills extend its life
        z.seed = rand(0, TAU);
        // seed a straight tail behind the head so the body has full length from
        // the first frame; it curves naturally as the trail fills with real path
        for (let k = SERPENT_PATH_N; k >= 1; k--) {
          z.pathHead = (z.pathHead + 1) % SERPENT_PATH_N;
          z.pathX[z.pathHead] = z.x - Math.cos(a) * SERPENT_PATH_SPACING * k;
          z.pathY[z.pathHead] = z.y - Math.sin(a) * SERPENT_PATH_SPACING * k;
        }
        z.pathN = SERPENT_PATH_N;
        this.zones.push(z);
        break;
      }
      case 'chime': {
        this.chimeN++;
        const every = st.special!.res3 ? 3 : 4;
        const cresc = this.chimeN % every === 0;
        audio.castChime(cresc);
        const R = st.radius! * this.aoeMul() * (cresc ? 1.5 : 1);
        const z = this.zonePool.acquire();
        this.resetZone(z, 'chimewave', p.x, p.y);
        z.r = 12; z.pr = 12; z.maxR = R;
        z.life = 0.4; z.maxLife = 0.4;
        z.dmg = st.damage! * this.dmgMul() * (cresc ? 2.2 : 1);
        z.evolved = cresc; // render: the crescendo rings full and brighter
        // The Last Hour stops time on the crescendo; Struck Silver stuns
        z.sleepDur = cresc ? (st.evolved ? 0.65 : 0) + (st.special!.stun ? 0.35 : 0) : 0;
        // the clock hand: each ordinary toll strikes one wedge of the hour,
        // advancing around the face; the crescendo tolls the whole circle at
        // once. The wedges tile the circle across a cycle, and the whole face
        // drifts slowly so the hand keeps ticking rather than strobing the same
        // sectors. z.ph = wedge half-width (0 = full circle), z.spin = its centre.
        if (cresc) {
          z.spin = 0; z.ph = 0;
        } else {
          const cones = every - 1;
          const coneW = TAU / cones;
          const idx = (this.chimeN % every) - 1;             // 0..cones-1 within the cycle
          const cyc = Math.floor((this.chimeN - 1) / every); // which full cycle
          z.spin = cyc * 0.45 + (idx + 0.5) * coneW;
          z.ph = coneW * 0.5;
        }
        z.hit = maskPool.acquire().begin();
        this.zones.push(z);
        // sparks fan out along the struck wedge, or ring the whole face on the toll
        const sparkN = cresc ? 26 : 14;
        for (let i = 0; i < sparkN; i++) {
          const a = z.ph > 0 ? z.spin + rand(-z.ph, z.ph) : rand(0, TAU);
          const sp = rand(cresc ? 60 : 120, cresc ? 260 : 300);
          this.particles.spawn({ x: p.x, y: p.y - 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.4, 0.8), size: rand(2, 5), color: '#ffd9a0', mode: 'star', rotV: rand(-5, 5), drag: 0.9 });
        }
        break;
      }
      case 'eye': {
        audio.castEye();
        const target = this.pickTarget(p.x, p.y, 800);
        const a0 = target ? Math.atan2(target.y - p.y, target.x - p.x) : rand(0, TAU);
        const dur = st.duration!;
        const turns = (st.turns || 1) + (st.special!.turns ? 0.5 : 0);
        const mkGaze = (ang: number, dir: number) => {
          const bm = this.beamPool.acquire();
          bm.dead = false;
          bm.kind = 'gaze';
          bm.x = p.x; bm.y = p.y - 20;
          bm.a = ang; bm.pa = ang;
          bm.len = st.length! * this.aoeMul(); bm.w = st.width!; // the gaze sweeps a full circle — AoE widens its reach
          bm.life = dur; bm.maxLife = dur;
          bm.dmg = st.damage! * this.dmgMul();
          bm.sweep = (dir * turns * TAU) / dur;
          bm.follow = true;
          bm.stun = !!st.special!.stun;
          bm.linger = !!st.evolved;
          bm.hit = maskPool.acquire().begin();   // first-touch stun tracking
          bm.hitT = timerPool.acquire().begin(); // re-hit cadence
          bm.int = 0.4;
          this.beams.push(bm);
        };
        mkGaze(a0, 1);
        if (st.evolved) mkGaze(a0 + Math.PI, -1);
        break;
      }
      case 'brand': {
        // write the red name on the biggest things on the field
        const cand: Enemy[] = [];
        for (const e of this.visibleEnemies()) if (!e.dead && e.nbT <= 0) cand.push(e);
        if (!cand.length) return;
        cand.sort((a, b) =>
          b.maxHp * (b.boss ? 4 : b.elite ? 2 : 1) - a.maxHp * (a.boss ? 4 : a.elite ? 2 : 1));
        const names = Math.min(st.count!, cand.length);
        audio.castBrand(this.panOf(cand[0].x));
        for (let i = 0; i < names; i++) {
          const e = cand[i];
          e.nbT = st.duration!;
          e.nbDps = st.dps! * this.dmgMul();
          e.nbPct = e.boss ? Math.min(e.maxHp * 0.005, 40) : Math.min(e.maxHp * 0.01, 50);
          e.nbTick = 0.5;
          e.nbAmp = st.special!.ash || 0;
          e.nbSpread = !!st.evolved;
          e.nbBurst = st.damage! * this.dmgMul();
          for (let k = 0; k < 14; k++) {
            const a = rand(0, TAU);
            this.particles.spawn({ x: e.x, y: e.y - e.radius, vx: Math.cos(a) * rand(20, 90), vy: Math.sin(a) * rand(20, 90) - 30, life: rand(0.4, 0.8), size: rand(2, 5), color: '#ff5a7a', color2: '#3d1020', mode: 'rune', rotV: rand(-4, 4), drag: 0.92 });
          }
          this.spawnText(e.x, e.y - e.radius - 20, 'BRANDED', '#ff5a7a', 0.8, -36, 13);
        }
        break;
      }
      case 'prism': {
        audio.castPrism();
        for (let i = 0; i < st.count!; i++) {
          const pt = this.densestPoint(st.range! * 0.6);
          const { x, y } = this.clampToView(
            pt ? pt.x + rand(-70, 70) : p.x + rand(-220, 220),
            pt ? pt.y + rand(-70, 70) : p.y + rand(-220, 220),
          );
          const z = this.zonePool.acquire();
          this.resetZone(z, 'prism', x, y - 30);
          z.r = 26; z.pr = 26;
          z.maxR = st.range!;
          z.life = st.duration!; z.maxLife = st.duration!;
          z.dmg = st.damage! * this.dmgMul();
          z.int = st.interval!;
          z.tick = 0.4 + i * 0.2;
          z.core = !!st.special!.facet;   // Twin Facet: two rays a volley
          z.evolved = !!st.evolved;       // refraction splinters
          z.seed = rand(0, TAU);
          this.zones.push(z);
        }
        break;
      }
    }
  }

  // a Kaleidoscope refraction: a short-lived analytic ray that hits once
  private spawnRay(x: number, y: number, a: number, len: number, dmg: number, w: number) {
    const bm = this.beamPool.acquire();
    bm.dead = false;
    bm.kind = 'ray';
    bm.x = x; bm.y = y;
    bm.a = a; bm.pa = a;
    bm.len = len; bm.w = w;
    bm.life = 0.16; bm.maxLife = 0.16;
    bm.dmg = dmg;
    bm.sweep = 0; bm.follow = false; bm.stun = false; bm.linger = false;
    bm.hit = maskPool.acquire().begin();
    bm.hitT = null;
    this.beams.push(bm);
  }

  private resetZone(z: Zone, kind: Zone['kind'], x: number, y: number) {
    z.kind = kind;
    z.dead = false;
    z.x = x; z.y = y; z.px = x; z.py = y;
    z.delay = 0;
    z.tick = 0; z.int = 0.8;
    z.spin = 0; z.seed = 0; z.ph = 0;
    z.dvx = 0; z.dvy = 0;
    z.evolved = false; z.boomed = false; z.echo = false; z.echoed = false;
    z.bossChill = false; z.bossPull = false;
    z.slowIn = 0; z.core = false; z.dissolve = 0; z.heal = 0;
    z.slow = 0; z.slowDur = 0; z.sleepDur = 0;
    z.pull = 0; z.knock = 0;
    z.dmg = 0; z.dps = 0;
    z.c1 = ''; z.c2 = '';
    z.hit = null;
    z.tick2 = 0; z.grow = 1; z.ox = 0; z.oy = 0;
    z.pathN = 0; z.pathHead = 0; z.pathAcc = 0;
  }

  private spawnBolt(x1: number, y1: number, x2: number, y2: number) {
    const b = this.boltPool.acquire();
    b.dead = false;
    b.life = 0.22; b.maxLife = 0.22;
    const segs = 7 + ((Math.random() * 4) | 0);
    const dx = x2 - x1, dy = y2 - y1;
    const nx = -dy, ny = dx;
    const L = Math.hypot(dx, dy) || 1;
    b.ptsX[0] = x1; b.ptsY[0] = y1;
    let n = 1;
    for (let i = 1; i < segs; i++) {
      const f = i / segs;
      const off = rand(-0.16, 0.16) * (1 - Math.abs(f - 0.5) * 1.4);
      b.ptsX[n] = x1 + dx * f + (nx / L) * off * L;
      b.ptsY[n] = y1 + dy * f + (ny / L) * off * L;
      n++;
    }
    b.ptsX[n] = x2; b.ptsY[n] = y2;
    b.n = n + 1;
    this.bolts.push(b);
  }

  private updateOrbitals(dt: number) {
    const s = this.player.spells.find((s) => s.id === 'petals');
    if (!s) return;
    const st = this.spellStats('petals', s.level, s.mastery || 0);
    const p = this.player;
    for (const o of this.orbitals) {
      o.px = o.x; o.py = o.y;
      o.a += st.speed! * dt * o.dir;
      const R = st.radius! * o.radF;
      o.x = p.x + Math.cos(o.a) * R;
      o.y = p.y + Math.sin(o.a) * R * 0.92;
      if (Math.random() < 0.6) this.particles.spawn({ x: o.x, y: o.y, vx: rand(-15, 15), vy: rand(-25, 5), life: rand(0.3, 0.7), size: rand(2.5, 5), color: Math.random() < 0.5 ? '#7dffb0' : '#ffd1ec', mode: 'petal', rotV: rand(-6, 6), drag: 0.95 });
      this.grid.queryCircle(o.x, o.y, 14 + 130, (e) => {
        if (!o.hitCd.ready(e.slot, this.t)) return;
        if (dist2(o.x, o.y, e.x, e.y) < (e.radius + 14) ** 2) {
          o.hitCd.set(e.slot, this.t + 0.5);
          this.damageEnemy(e, st.damage! * this.dmgMul(), '#7dffb0', 'nature');
          audio.petalTick(this.panOf(e.x));
          const a = Math.atan2(e.y - p.y, e.x - p.x);
          const kn = st.special!.knock2 ? 240 : 120;
          e.knbx += Math.cos(a) * kn;
          e.knby += Math.sin(a) * kn;
        }
      });
      // Mirror Waltz: a petal brushing an enemy shot may bat it straight back
      if (st.special!.reflect) {
        for (const bp of this.bossProjectiles) {
          if (bp.reflected || bp.life <= 0 || bp.parryT > this.t) continue;
          if (dist2(o.x, o.y, bp.x, bp.y) >= (bp.r + 14) ** 2) continue;
          bp.parryT = this.t + 0.45;
          if (Math.random() * 100 >= st.special!.reflect) continue;
          bp.reflected = true;
          bp.vx = -bp.vx; bp.vy = -bp.vy;
          bp.life = Math.max(bp.life, 4);
          audio.petalTick(this.panOf(bp.x));
          for (let k = 0; k < 8; k++) {
            const a = rand(0, TAU);
            this.particles.spawn({ x: bp.x, y: bp.y, vx: Math.cos(a) * rand(60, 180), vy: Math.sin(a) * rand(60, 180), life: rand(0.2, 0.45), size: rand(2.5, 5), endSize: 0.5, color: Math.random() < 0.5 ? '#7dffb0' : '#ffd1ec', mode: 'petal', rotV: rand(-8, 8), drag: 0.88 });
          }
        }
      }
    }
  }

  // Rimeheart: slow orbs of condensed cold sweeping a wide orbit. Each graze is
  // heavy but gated per-foe, and leaves a clinging chill; the Winterloom
  // evolution has the orbs loose ice shards at nearby foes.
  private updateFrostOrbs(dt: number) {
    const s = this.player.spells.find((s) => s.id === 'frost');
    if (!s) { if (this.frostOrbs.length) this.rebuildFrostOrbs(); return; }
    const st = this.spellStats('frost', s.level, s.mastery || 0);
    const want = Math.max(1, st.count!);
    if (this.frostOrbs.length !== want) this.rebuildFrostOrbs(); // second orb / Twin Rime
    const p = this.player;
    const R = st.radius!;                              // fixed orbit range — AoE does NOT push it outward
    const orbR = (24 + s.level * 1.5) * this.aoeMul(); // AoE fattens the ball itself
    const dmg = st.damage! * this.dmgMul();
    const slow = st.slow!, slowDur = st.slowDur!;
    const evolved = !!s.evolved;
    for (const o of this.frostOrbs) {
      o.px = o.x; o.py = o.y;
      o.a += st.speed! * dt;
      // the orbit breathes: each orb drifts smoothly out to ~+30% of the base
      // range and back on a slow cycle, slightly out of phase per orb
      const breath = 1.15 + 0.15 * Math.sin(this.t * 0.8 + o.seed);
      const rr = R * o.radF * breath;
      o.x = p.x + Math.cos(o.a) * rr;
      o.y = p.y + Math.sin(o.a) * rr * 0.92; // the dream's shallow perspective tilt
      // a slow veil of frost-motes trailing the orb
      if (Math.random() < 0.7) this.particles.spawn({ x: o.x + rand(-6, 6), y: o.y + rand(-6, 6), vx: rand(-14, 14), vy: rand(-24, 6), life: rand(0.4, 0.9), size: rand(2.5, 5.5), endSize: 1, color: Math.random() < 0.5 ? '#e8fbff' : '#8fe8ff', mode: Math.random() < 0.35 ? 'shard' : 'glow', rotV: rand(-5, 5), drag: 0.93 });
      // heavy graze: wound and chill everything the orb sweeps, gated per-foe
      this.grid.queryCircle(o.x, o.y, orbR + 60, (e) => {
        if (!o.hitCd.ready(e.slot, this.t)) return;
        if (dist2(o.x, o.y, e.x, e.y) < (e.radius + orbR) ** 2) {
          o.hitCd.set(e.slot, this.t + 0.55);
          this.damageEnemy(e, dmg, '#bff1ff', 'frost');
          if (!e.boss) { e.slow = Math.max(e.slow, slow); e.slowT = Math.max(e.slowT, slowDur); }
          audio.petalTick(this.panOf(e.x));
          for (let k = 0; k < 5; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-120, 120), vy: rand(-120, 120), life: rand(0.2, 0.45), size: rand(2, 4), color: '#cdf3ff', mode: 'shard', rotV: rand(-8, 8), drag: 0.86 });
        }
      });
      // Winterloom: the crystallized orb looses ice shards at nearby foes — a
      // rapid stream, retargeting the nearest foe each shot
      if (evolved) {
        o.shardCd -= dt;
        if (o.shardCd <= 0) {
          const target = this.nearestEnemy(o.x, o.y, 380);
          if (target) { o.shardCd = 0.4 * this.cdMul(); this.fireIceShard(o.x, o.y, target, dmg * 0.5); }
          else o.shardCd = 0.2; // keep watching rather than idling a full beat
        }
      }
    }
  }

  private fireIceShard(x: number, y: number, target: Enemy, dmg: number) {
    const a = Math.atan2(target.y - y, target.x - x);
    const pr = this.newProj('iceshard');
    pr.x = x; pr.y = y; pr.px = x; pr.py = y;
    pr.vx = Math.cos(a) * 640; pr.vy = Math.sin(a) * 640;
    pr.dmg = dmg; pr.r = 9; pr.life = 1.0; pr.a = a; pr.chill = true;
    this.projectiles.push(pr);
    audio.iceShard(this.panOf(x));
  }

  // -------------------------------------------------------------- damage
  // Every point of damage carries an element. Elements leave marks; marks
  // react with other elements — the Resonance system:
  //   frost family  → chill (the existing slow)
  //   storm         → CHARGE:  the foe dies crackling — bolts leap to its kin
  //   light         → BRAND:   +12% damage taken from everything while it lasts
  //   fire on a chilled foe   → SHATTER: an icy burst wounds the crowd
  //   shadow on a branded foe → ECLIPSE: the brand collapses into a dark burst
  // Reaction bursts are 'cosmic' so they never chain into further reactions
  // (except Discharge, which cascades by design through charged corpses).
  damageEnemy(e: Enemy, dmg: number, color = '#fff', element: Element = 'arcane') {
    if (e.dead) return;
    // Brittle Dreams: slowed foes take amplified damage
    if (this.chillAmp && e.slowT > 0) dmg *= 1 + this.chillAmp / 100;
    // moonlight brand: the marked take more from everything
    if (e.brandT > 0) dmg *= 1.12;
    // Written in Ash: the nightmare-branded take more from everything
    if (e.nbT > 0 && e.nbAmp) dmg *= 1 + e.nbAmp / 100;
    let crit = false;
    if (this.meta.crit && Math.random() < this.meta.crit / 100) {
      crit = true;
      dmg *= 1.5 + (this.meta.critDmg || 0) / 100;
    }
    e.hp -= dmg;
    e.hitFlash = 0.12;
    audio.hit(this.panOf(e.x));
    // marks
    if (element === 'storm') {
      e.chargeT = this.markDur(4);
      e.chargeDmg = Math.max(e.chargeDmg, dmg * 0.35);
    } else if (element === 'light') {
      e.brandT = this.markDur(3.5);
    }
    if (crit && this.relics.has('moonsickle')) e.brandT = this.markDur(3.5);
    // reactions (per-enemy cooldown so dense builds don't strobe) — lethal
    // hits react too: the killing blow is the moment the burst should sing
    if (e.reactCd <= this.t) {
      if (element === 'fire' && e.slowT > 0) {
        e.reactCd = this.t + 1.0;
        this.react('shatter', e, dmg);
      } else if (element === 'shadow' && e.brandT > 0) {
        e.brandT = 0;
        e.reactCd = this.t + 1.0;
        this.react('eclipse', e, dmg);
      }
    }
    // Floating damage numbers, throttled per-enemy (see original notes)
    if (crit || e.boss || e.dmgTextT <= this.t) {
      e.dmgTextT = this.t + 0.28;
      // crits bypass the per-enemy throttle but not without limit: past the cap
      // the screen is unreadable noise and the texts alone can dominate the
      // frame (observed 300+ under an evolved-crit endgame build). Both caps are
      // the player's damage-number performance preset (see settings.ts).
      if (this.texts.length < settings.dmgTextCap || e.boss || (crit && this.texts.length < settings.dmgTextCritCap)) {
        // crits keep the spell's own hit colour — size, lifetime and the '!'
        // carry the emphasis instead of a universal gold
        this.spawnText(e.x + rand(-8, 8), e.y - e.radius - 6, String(Math.round(dmg)) + (crit ? '!' : ''), color, crit ? 0.85 : 0.55, -55, (e.boss ? 18 : 13) + (crit ? 4 : 0));
      }
    }
    if (e.hp <= 0) this.killEnemy(e);
  }

  // A resonance reaction blooming off enemy `e`, seeded by the hit that
  // triggered it. Prism Heart makes every reaction half again as strong.
  private react(kind: 'shatter' | 'eclipse', e: Enemy, trig: number) {
    const mul = this.relics.has('prismheart') ? 1.5 : 1;
    if (kind === 'shatter') {
      const R = 95 * this.aoeMul();
      const dmg = trig * 0.7 * mul;
      audio.explode(this.panOf(e.x));
      this.spawnText(e.x, e.y - e.radius - 22, 'SHATTER', '#bff1ff', 0.9, -42, 15);
      this.particles.spawn({ x: e.x, y: e.y, life: 0.4, size: R * 1.1, color: '#bff1ff', mode: 'ring' });
      for (let k = 0; k < 26; k++) {
        const a = rand(0, TAU);
        this.particles.spawn({ x: e.x, y: e.y, vx: Math.cos(a) * rand(120, 380), vy: Math.sin(a) * rand(120, 380), life: rand(0.3, 0.7), size: rand(3, 7), endSize: 1, color: '#e8fbff', color2: '#8fe8ff', mode: 'shard', rotV: rand(-9, 9), drag: 0.88 });
      }
      this.grid.queryCircle(e.x, e.y, R + 60, (o) => {
        if (o === e) return;
        if (dist2(e.x, e.y, o.x, o.y) < (R + o.radius) ** 2) {
          this.damageEnemy(o, dmg, '#bff1ff', 'cosmic');
          if (!o.dead && !o.boss) { o.slow = Math.max(o.slow, 0.4); o.slowT = Math.max(o.slowT, 1); }
        }
      });
    } else {
      const R = 85 * this.aoeMul();
      const dmg = trig * 0.9 * mul;
      audio.castVoid();
      this.spawnText(e.x, e.y - e.radius - 22, 'ECLIPSE', '#c9a4ff', 0.9, -42, 15);
      this.particles.spawn({ x: e.x, y: e.y, life: 0.42, size: R * 1.15, color: '#9a5cff', mode: 'ring' });
      for (let k = 0; k < 22; k++) {
        const a = rand(0, TAU);
        this.particles.spawn({ x: e.x, y: e.y, vx: Math.cos(a) * rand(80, 300), vy: Math.sin(a) * rand(80, 300), life: rand(0.3, 0.7), size: rand(3, 6), endSize: 0.5, color: '#9a5cff', color2: '#fff3b8', mode: 'glow', drag: 0.88 });
      }
      this.grid.queryCircle(e.x, e.y, R + 60, (o) => {
        if (o === e) return;
        if (dist2(e.x, e.y, o.x, o.y) < (R + o.radius) ** 2) this.damageEnemy(o, dmg, '#c9a4ff', 'cosmic');
      });
    }
  }

  private spawnText(x: number, y: number, str: string, color: string, life: number, vy: number, size: number) {
    const t = this.textPool.acquire();
    t.dead = false;
    t.x = x; t.y = y; t.str = str; t.color = color; t.life = life; t.vy = vy; t.size = size;
    this.texts.push(t);
  }

  private spawnGem(x: number, y: number, v: number, big: boolean, heal: boolean, shard: boolean, ph: number) {
    const g = this.gemPool.acquire();
    g.dead = false;
    g.x = x; g.y = y; g.px = x; g.py = y;
    g.v = v; g.big = big; g.heal = heal; g.shard = shard; g.merged = false;
    g.ph = ph;
    this.gems.push(g);
  }

  killEnemy(e: Enemy) {
    e.dead = true;
    this.kills++;
    // DISCHARGE: a charged foe dies crackling — its stored storm leaps to
    // nearby kin. Chains cascade on purpose: charged deaths beget charged
    // deaths, and a well-stormed crowd goes up like a string of firecrackers.
    if (e.chargeT > 0 && e.chargeDmg > 0) {
      // each cascade generation emits at half the strength of the last, so
      // deep chains still light up the screen without wiping it
      const mul = (this.relics.has('prismheart') ? 1.5 : 1) * Math.pow(0.5, this.dischargeDepth);
      audio.castStorm();
      this.spawnText(e.x, e.y - e.radius - 22, 'DISCHARGE', '#bfeaff', 0.8, -42, 14);
      let arcs = 0;
      this.dischargeDepth++;
      this.grid.queryCircle(e.x, e.y, 280, (o) => {
        if (arcs >= 3 || o === e || o.dead) return;
        if (dist2(e.x, e.y, o.x, o.y) < 280 * 280) {
          arcs++;
          this.spawnBolt(e.x, e.y, o.x, o.y);
          this.damageEnemy(o, e.chargeDmg * mul, '#bfeaff', 'cosmic');
        }
      });
      this.dischargeDepth--;
    }
    // THE DEBT: a nightmare-branded foe dies — the red name is paid in a dark
    // burst, and (evolved) leaps to three of its kin, a contagion of debts.
    if (e.nbT > 0 && e.nbBurst > 0) {
      const R = 70 * this.aoeMul();
      const burst = e.nbBurst;
      e.nbT = 0;
      this.particles.spawn({ x: e.x, y: e.y, life: 0.4, size: R * 1.15, color: '#ff5a7a', mode: 'ring' });
      for (let k = 0; k < 18; k++) {
        const a = rand(0, TAU);
        this.particles.spawn({ x: e.x, y: e.y, vx: Math.cos(a) * rand(80, 300), vy: Math.sin(a) * rand(80, 300), life: rand(0.25, 0.6), size: rand(2.5, 6), endSize: 0.5, color: '#ff5a7a', color2: '#3d1020', mode: 'glow', drag: 0.88 });
      }
      this.grid.queryCircle(e.x, e.y, R + 60, (o) => {
        if (o === e || o.dead) return;
        if (dist2(e.x, e.y, o.x, o.y) < (R + o.radius) ** 2) this.damageEnemy(o, burst, '#ff5a7a', 'shadow');
      });
      if (e.nbSpread) {
        const heirs: Enemy[] = [];
        this.grid.queryCircle(e.x, e.y, 320, (o) => {
          if (o !== e && !o.dead && o.nbT <= 0 && heirs.length < 3) heirs.push(o);
        });
        for (const o of heirs) {
          o.nbT = 4;
          o.nbDps = e.nbDps * 0.9;
          o.nbPct = o.boss ? Math.min(o.maxHp * 0.005, 40) : Math.min(o.maxHp * 0.01, 50);
          o.nbTick = 0.5;
          o.nbAmp = e.nbAmp;
          o.nbSpread = true;
          o.nbBurst = e.nbBurst * 0.9;
          // the name travels as a thin red seam
          const steps = 6;
          for (let k2 = 1; k2 < steps; k2++) {
            const f = k2 / steps;
            this.particles.spawn({ x: e.x + (o.x - e.x) * f, y: e.y + (o.y - e.y) * f, vx: rand(-12, 12), vy: rand(-24, -6), life: rand(0.3, 0.55), size: rand(1.5, 3), color: '#ff5a7a', mode: 'glow', drag: 0.92 });
          }
        }
      }
    }
    const n = e.boss ? 160 : e.elite ? 46 : 18;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, e.boss ? 420 : 240);
      this.particles.spawn({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.4, e.boss ? 1.6 : 0.9), size: rand(2, e.boss ? 8 : 5), color: e.color, color2: '#ffffff', mode: Math.random() < 0.7 ? 'glow' : 'star', rotV: rand(-5, 5), drag: 0.9 });
    }
    this.particles.spawn({ x: e.x, y: e.y, life: 0.5, size: e.radius * (e.boss ? 4 : 2.6), color: e.color, mode: 'ring' });
    if (e.boss) {
      audio.bossDown();
      this.shake = 16;
      this.flash = { color: '255,210,122', a: 0.4 };
      for (let i = 0; i < 18; i++) this.spawnGem(e.x + rand(-70, 70), e.y + rand(-70, 70), 14, true, false, false, rand(0, TAU));
      this.spawnGem(e.x, e.y, 0, false, true, false, 0);
      // a nightmare shard — the Dark Bargain's coin, torn only from bosses
      this.spawnGem(e.x + rand(-30, 30), e.y + rand(-30, 30), 0, false, false, true, rand(0, TAU));
      this.breather = 8;
      this.setBanner('THE TIDE RECEDES', '#7ff5ff');
      // and the dream offers a relic — opened from simStep once no other
      // overlay holds the floor
      this.relicQueue++;
    } else if (e.golden) {
      const d = this.dustReward(1.5);
      this.bonusDust += d;
      this.setBanner(`+${d} STARDUST`, '#ffd27a');
      audio.bonus();
      for (let i = 0; i < 8; i++) this.spawnGem(e.x + rand(-45, 45), e.y + rand(-45, 45), 5, true, false, false, rand(0, TAU));
    } else {
      audio.kill(this.panOf(e.x), e.elite);
      const drops = e.elite ? 4 : 1;
      for (let i = 0; i < drops; i++) this.spawnGem(e.x + rand(-14, 14), e.y + rand(-14, 14), e.xp, e.elite, false, false, rand(0, TAU));
      if (this.meta.extraGem && Math.random() * 100 < this.meta.extraGem) this.spawnGem(e.x + rand(-18, 18), e.y + rand(-18, 18), e.xp, false, false, false, rand(0, TAU));
      if (Math.random() < 0.008) this.spawnGem(e.x, e.y, 0, false, true, false, 0);
    }
    // Stargrave: the dead burst and wound their kin
    if (this.meta.deathBurst && !e.boss && !this.burstGuard) {
      this.burstGuard = true;
      const R = 55 + e.radius;
      for (const o of this.enemies) {
        if (o.dead || o === e) continue;
        if (dist2(e.x, e.y, o.x, o.y) < R * R) this.damageEnemy(o, e.maxHp * 0.12, '#c9a4ff');
      }
      this.burstGuard = false;
      this.particles.spawn({ x: e.x, y: e.y, life: 0.35, size: R, color: '#c9a4ff', mode: 'ring' });
    }
    // Night Chalice: foes that die near you spill a drop of life back
    const p = this.player;
    if (this.relics.has('chalice') && this.chaliceCd <= 0 && p.hp < p.maxHp && dist2(e.x, e.y, p.x, p.y) < 230 * 230) {
      this.chaliceCd = 1.5;
      p.hp = Math.min(p.maxHp, p.hp + 1);
      this.particles.spawn({ x: p.x, y: p.y - 20, vx: 0, vy: -30, life: 0.5, size: 3.5, color: '#7dffb0', mode: 'glow', drag: 0.95 });
    }
    // Hourglass of the Deep: elite kills flood every surge at once
    if (e.elite && this.relics.has('hourglass')) {
      for (const k of SURGE_KEYS) this.surges[k] = 4;
      this.spawnText(p.x, p.y - 66, 'THE HOURGLASS TURNS', '#7dffb0', 1.3, -28, 15);
      audio.bonus();
    }
  }

  // A single enemy melee hit. No shared i-frames: pacing comes from each
  // enemy's own attack cooldown. A brief lunge + spark toward the player reads
  // the swing without a wind-up.
  meleeStrike(e: Enemy) {
    const p = this.player;
    // Melee ignores the projectile i-frame window entirely (pacing is the
    // per-enemy cooldown); only the Second Wind invuln shields against it.
    if (p.dead || p.invuln > 0) return;
    const a = Math.atan2(p.y + PLAYER_HURT_DY - e.y, p.x - e.x);
    const hx = e.x + Math.cos(a) * (e.radius + e.meleeReach);
    const hy = e.y + Math.sin(a) * (e.radius + e.meleeReach);
    // bright spray fanning toward the player from the strike point
    for (let k = 0; k < 9; k++) {
      const sa = a + rand(-0.6, 0.6);
      this.particles.spawn({
        x: hx, y: hy,
        vx: Math.cos(sa) * rand(160, 340),
        vy: Math.sin(sa) * rand(160, 340),
        life: rand(0.12, 0.26), size: rand(3, 6), endSize: 0.5,
        color: '#ffffff', color2: e.color, mode: 'star', rotV: rand(-8, 8), drag: 0.82,
      });
    }
    // a single soft flash pop at the impact point
    this.particles.spawn({ x: hx, y: hy, life: 0.16, size: e.radius * 0.7 + 8, endSize: 2, color: '#ffffff', color2: e.color, mode: 'glow', drag: 1 });
    // Thorned Halo: whoever wounds you wears vengeful moonlight
    if (this.relics.has('thornedhalo')) e.brandT = this.markDur(5);
    // apply damage directly: melee grants no follow-up immunity
    this.hurtPlayer(e.dmg, 0, true);
  }

  hurtPlayer(dmg: number, iframeDur = 0.45, melee = false) {
    const p = this.player;
    // projectiles respect the short i-frame; melee bypasses it (only Second
    // Wind's invuln, tracked separately, stops a hit landing).
    if (p.dead || p.invuln > 0) return;
    if (!melee && p.iframes > 0) return;
    if (iframeDur > 0) p.iframes = iframeDur;
    // Somnal Ward drinks the blow before it reaches your life
    if (p.shield > 0) {
      const soak = Math.min(p.shield, dmg);
      p.shield -= soak;
      dmg -= soak;
      audio.wardHit(this.panOf(p.x));
      // shield-hit feedback: a soft blue flash + a light kick — clearly a blow
      // caught by the glass, gentler than a wound to the flesh. (If this hit also
      // breaks the ward, wardShatter's stronger flash below overrides it.)
      this.flash = { color: '143,184,255', a: 0.16 };
      this.shake = Math.min(4, this.shake + 2);
      for (let i = 0; i < 12; i++) this.particles.spawn({ x: p.x + rand(-16, 16), y: p.y - 20 + rand(-16, 16), vx: rand(-170, 170), vy: rand(-190, 40), life: rand(0.2, 0.5), size: rand(2, 5), endSize: 0.5, color: Math.random() < 0.5 ? '#e6f0ff' : '#8fb8ff', mode: 'shard', rotV: rand(-8, 8), drag: 0.86 });
      if (p.shield <= 0) { p.shield = 0; p.shieldT = p.shieldDelay; this.wardShatter(); }
      if (dmg <= 0.001) return; // the glass caught it whole — no life lost
    }
    p.hp -= dmg;
    audio.hurt();
    // a light, brief kick — camera shake is otherwise reserved for boss moments
    this.shake = Math.min(6, this.shake + 3.5);
    this.flash = { color: '255,90,120', a: 0.28 };
    // Frozen Tear: winter answers the wound
    if (this.relics.has('frozentear') && this.tearCd <= 0) {
      this.tearCd = 6;
      audio.castFrost();
      const z = this.zonePool.acquire();
      this.resetZone(z, 'frostwave', p.x, p.y);
      z.r = 10; z.pr = 10; z.maxR = 240 * this.aoeMul();
      z.life = 0.45; z.maxLife = 0.45;
      z.dmg = (24 + p.level * 5) * this.dmgMul();
      z.slow = 0.6;
      z.slowDur = 2.2;
      z.hit = maskPool.acquire().begin();
      this.zones.push(z);
    }
    for (let i = 0; i < 16; i++) this.particles.spawn({ x: p.x, y: p.y - 16, vx: rand(-180, 180), vy: rand(-220, 40), life: rand(0.3, 0.7), size: rand(2, 5), color: '#ff7aa8', mode: 'glow', drag: 0.9 });
    if (p.hp <= 0 && this.meta.cheatDeath && !this.cheated) {
      // Second Wind — refuse to wake, once per dream
      this.cheated = true;
      p.hp = p.maxHp * 0.5;
      p.invuln = 2.2;
      this.flash = { color: '125,255,176', a: 0.45 };
      this.spawnText(p.x, p.y - 60, 'SECOND WIND', '#7dffb0', 1.8, -20, 20);
      for (let i = 0; i < 50; i++) {
        const a = (i / 50) * TAU;
        this.particles.spawn({ x: p.x, y: p.y, vx: Math.cos(a) * rand(100, 260), vy: Math.sin(a) * rand(100, 260), life: rand(0.5, 1), size: rand(2, 5), color: '#7dffb0', mode: 'star', rotV: rand(-4, 4), drag: 0.9 });
      }
      return;
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      this.paused = true;
      // nothing queued from the rest of this frame may reopen a menu and unpause
      this.pendingLevels = 0;
      this.relicQueue = 0;
      audio.death();
      this.hooks.onGameOver({ time: this.t, kills: this.kills, level: p.level, bonusDust: this.bonusDust, shards: this.shardsEarned, relics: [...this.relics] });
    }
  }

  explode(x: number, y: number, radius: number, dmg: number, pal: { ring: string; core: string; sparks: string[]; text: string; quiet?: boolean } | null = null, element: Element = 'fire') {
    if (!pal || !pal.quiet) audio.explode(this.panOf(x));
    const textCol = pal ? pal.text : '#ffbe8a';
    this.grid.queryCircle(x, y, radius + 130, (e) => {
      if (dist2(x, y, e.x, e.y) < (radius + e.radius) ** 2) {
        this.damageEnemy(e, dmg, textCol, element);
      }
    });
    // Cinderheart: every explosion leaves the ground burning where it bloomed
    if (this.relics.has('cinderheart')) {
      this.spawnScorch(x, y, radius * 0.7, dmg * 0.22, '#ff8c5a', '#ffd27a');
    }
    const ring = pal ? pal.ring : '#ffd27a';
    const core = pal ? pal.core : '#ffffff';
    const sparks = pal ? pal.sparks : ['#ffd27a', '#ff8c5a', '#ff5a7a'];
    this.particles.spawn({ x, y, life: 0.45, size: radius * 1.25, color: ring, mode: 'ring' });
    this.particles.spawn({ x, y, life: 0.3, size: radius * 0.8, color: core, color2: sparks[0], mode: 'glow' });
    const n = pal && pal.quiet ? 24 : 44;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      this.particles.spawn({ x, y, vx: Math.cos(a) * rand(60, 380), vy: Math.sin(a) * rand(60, 380) - 40, life: rand(0.35, 0.95), size: rand(2.5, 7), endSize: 0.5, color: pick(sparks), color2: '#5a2a10', mode: 'glow', ay: 160, drag: 0.9 });
    }
    for (let i = 0; i < 8; i++) this.particles.spawn({ x, y, vx: rand(-40, 40), vy: rand(-70, -20), life: rand(0.7, 1.3), size: rand(14, 26), endSize: 34, color: 'rgba(70,40,90,0.55)', mode: 'smoke', drag: 0.95 });
  }

  pushHud(force = false) {
    const p = this.player;
    // Signature at DISPLAY granularity (whole hp, 0.5% xp steps, whole seconds).
    // If nothing the HUD renders has changed, skip building the object tree and
    // the React re-render entirely — the 10Hz cadence otherwise promotes a
    // steady stream of short-lived trees into the old generation.
    let sig = `${Math.ceil(p.hp)}|${p.maxHp}|${Math.round(p.shield)}|${p.shieldMax}|${p.level}|${((p.xp / p.xpNext) * 200) | 0}|${Math.floor(this.t)}|${this.kills}|${this.bonusDust}|${this.shardsEarned}|${this.relics.size}|${this.paused ? 1 : 0}`;
    for (const s of p.spells) sig += `|${s.id}${s.level}${s.evolved ? '*' : ''}${s.mastery || 0}`;
    for (const k in p.boons) sig += `|${k}${p.boons[k]}`;
    if (!force && sig === this.hudSig) return;
    this.hudSig = sig;
    this.hooks.onHud({
      hp: p.hp, maxHp: p.maxHp, xp: p.xp, xpNext: p.xpNext, level: p.level,
      shield: p.shield, shieldMax: p.shieldMax,
      time: this.t, kills: this.kills,
      ahead: this.meta.baneAhead || 0,
      spells: p.spells.map((s) => ({ id: s.id, level: s.level, evolved: !!s.evolved })),
      spellCap: this.spellCap(),
      boons: { ...p.boons },
      relics: [...this.relics],
      dust: dustForRun({ kills: this.kills, level: p.level, time: this.t, bonusDust: this.bonusDust }, this.meta),
      shards: this.shardsEarned,
      paused: this.paused,
    }, force);
  }

  // ================================================================ sim step
  private simStep(dt: number) {
    this.t += dt;
    this.computeWave();
    this.computeDifficulty();
    const p = this.player;

    // dream tides: every 8s each awakened surge has a chance to swell
    if (this.meta.surge) {
      this.surgeT -= dt;
      if (this.surgeT <= 0) {
        this.surgeT = 8;
        const dur = 4 + (this.meta.surgeDur || 0);
        let sy = 0;
        for (const k of SURGE_KEYS) {
          if (this.meta.surge[k] > 0 && Math.random() * 100 < this.meta.surge[k]) {
            this.surges[k] = dur;
            const look = SURGE_LOOK[k];
            this.spawnText(p.x, p.y - 66 - sy, look.str, look.color, 1.3, -28, 15);
            sy += 20;
            for (let i = 0; i < 22; i++) {
              const a = rand(0, TAU);
              this.particles.spawn({ x: p.x, y: p.y - 12, vx: Math.cos(a) * rand(60, 220), vy: Math.sin(a) * rand(60, 220), life: rand(0.4, 0.9), size: rand(2, 5), color: look.color, mode: 'star', rotV: rand(-5, 5), drag: 0.9 });
            }
          }
        }
      }
    }
    // surges decay outside the meta guard: the Hourglass relic grants them
    // even on builds with no surge nodes awakened
    for (const k of SURGE_KEYS) {
      const v = this.surges[k];
      if (v > 0) this.surges[k] = Math.max(0, v - dt);
    }

    // input
    p.px = p.x; p.py = p.y;
    let mx = (this.keys['d'] || this.keys['arrowright'] ? 1 : 0) - (this.keys['a'] || this.keys['arrowleft'] ? 1 : 0);
    let my = (this.keys['s'] || this.keys['arrowdown'] ? 1 : 0) - (this.keys['w'] || this.keys['arrowup'] ? 1 : 0);
    const L = Math.hypot(mx, my);
    if (L > 0) { mx /= L; my /= L; p.facing = mx !== 0 ? Math.sign(mx) : p.facing; }
    p.moving = L > 0;
    const spd = p.speed * (this.surges.speed > 0 ? 1.35 : 1);
    p.x += mx * spd * dt;
    p.y += my * spd * dt;
    p.animT += dt * (p.moving ? 2.2 : 1);
    p.iframes = Math.max(0, p.iframes - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    p.castPulse = Math.max(0, p.castPulse - dt * 3);
    // Dream Anchor: stillness gathers power (and shows it, gently)
    this.standT = p.moving ? 0 : this.standT + dt;
    if (this.relics.has('anchor') && this.standT >= 0.8 && Math.random() < 0.14) {
      const a = rand(0, TAU);
      this.particles.spawn({ x: p.x + Math.cos(a) * 26, y: p.y - 10 + Math.sin(a) * 14, vx: 0, vy: -22, life: rand(0.4, 0.8), size: rand(1.5, 3), color: '#9fd8ff', mode: 'glow', drag: 0.96 });
    }
    // relic clocks
    this.tearCd = Math.max(0, this.tearCd - dt);
    this.chaliceCd = Math.max(0, this.chaliceCd - dt);
    if (this.relics.has('cometring')) {
      this.cometT -= dt;
      if (this.cometT <= 0) {
        this.cometT = 12;
        const R = 95 * this.aoeMul();
        const pt = this.densestPoint(R);
        if (pt) {
          const pr = this.newProj('comet');
          pr.tx = pt.x; pr.ty = pt.y;
          pr.x = pt.x + rand(-140, -60); pr.y = pt.y - 560;
          pr.px = pr.x; pr.py = pr.y;
          pr.t = 0; pr.dur = rand(0.5, 0.7);
          pr.dmg = (30 + p.level * 7) * this.dmgMul();
          pr.range = R;
          pr.life = 1;
          this.projectiles.push(pr);
          audio.castStarfall();
        }
      }
    }
    const regen = (p.boons.regen || 0) + (this.meta.regen || 0) + this.pact.regen;
    if (regen) {
      p.regenT += dt;
      if (p.regenT >= 2) { p.regenT = 0; p.hp = Math.min(p.maxHp, p.hp + regen); }
    }
    if (p.moving && Math.random() < 0.5) {
      this.particles.spawn({ x: p.x + rand(-8, 8), y: p.y + rand(-2, 6), vx: rand(-12, 12), vy: rand(-30, -6), life: rand(0.4, 0.9), size: rand(1.5, 3.5), color: pick(['#b48cff', '#7ff5ff', '#ffd27a']), mode: 'glow', drag: 0.96 });
    }
    // remember where the player stood (Mirrored Self, Wisp Choir)
    this.histI = (this.histI + 1) & (HIST_N - 1);
    this.histX[this.histI] = p.x;
    this.histY[this.histI] = p.y;

    this.updateSpawning(dt);
    this.castSpells(dt);

    // enemies
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.px = e.x; e.py = e.y;
      e.animT += dt;
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.slowT = Math.max(0, e.slowT - dt);
      e.ccImmT = Math.max(0, e.ccImmT - dt);
      if (e.ccImmT <= 0 && e.ccSat > 0) e.ccSat = Math.max(0, e.ccSat - dt * CC_DECAY);
      e.chargeT = Math.max(0, e.chargeT - dt);
      e.brandT = Math.max(0, e.brandT - dt);
      if (e.chargeT <= 0) e.chargeDmg = 0;
      // the Nightmare Brand collects its debt in slow red heartbeats
      if (e.nbT > 0) {
        e.nbT = Math.max(0, e.nbT - dt);
        e.nbTick -= dt;
        if (e.nbTick <= 0) {
          e.nbTick = 0.5;
          audio.brandThump(this.panOf(e.x));
          this.damageEnemy(e, (e.nbDps + e.nbPct) * 0.5, '#ff5a7a', 'shadow');
          if (e.dead) continue;
        }
      }
      // lucid moments: the whole battlefield dilates into slow motion
      const lucid = this.lucidT > 0 ? LUCID_SLOW : 1;
      const slowMul = (e.slowT > 0 ? 1 - e.slow : 1) * lucid;
      // golden wisp: flees, never attacks, escapes when its time runs out — and
      // the lucid dream slows its flight too, so it's far easier to run down
      if (e.golden) {
        e.goldT -= dt;
        if (e.goldT <= 0) {
          // it slips back out of the dream — vanish with a wisp's dying
          // flourish (a gold ring + scattering motes flitting upward) so it
          // reads as fleeing, not simply blinking out of existence
          this.particles.spawn({ x: e.x, y: e.y, life: 0.5, size: e.radius * 2.6, color: '#ffd27a', mode: 'ring' });
          for (let i = 0; i < 16; i++) {
            const a = rand(0, TAU);
            const sp = rand(40, 220);
            this.particles.spawn({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: rand(0.4, 0.9), size: rand(2, 5), endSize: 0.5, color: '#ffd27a', color2: '#fff2cc', mode: Math.random() < 0.6 ? 'glow' : 'star', rotV: rand(-5, 5), drag: 0.9 });
          }
          audio.banish(); // a soft dismissal — it slipped away, no reward chime
          e.dead = true;
          continue;
        }
        const fa = Math.atan2(e.y - p.y, e.x - p.x) + Math.sin(e.animT * 4 + e.seed) * 0.6;
        e.x += (Math.cos(fa) * e.speed * lucid + e.knbx) * dt;
        e.y += (Math.sin(fa) * e.speed * lucid + e.knby) * dt;
        e.knbx *= Math.pow(0.02, dt);
        e.knby *= Math.pow(0.02, dt);
        if (Math.random() < 0.5) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-20, 20), vy: rand(-40, -10), life: rand(0.4, 0.8), size: rand(2, 4), color: '#ffd27a', mode: 'star', rotV: rand(-5, 5), drag: 0.94 });
        continue;
      }
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      const wob = Math.sin(e.animT * 3 + e.seed) * 0.4;
      const rangedDef = !e.boss ? e.ranged : null;
      if (rangedDef) {
        // hover at range: advance when far, retreat when crowded, strafe between
        const D = Math.sqrt(dist2(e.x, e.y, p.x, p.y));
        let moveA = a;
        let sp = e.speed;
        if (D > rangedDef.range) moveA = a;
        else if (D < rangedDef.range * 0.55) moveA = a + Math.PI;
        else { moveA = a + Math.PI / 2 * (e.seed > 500 ? 1 : -1); sp *= 0.5; }
        e.x += (Math.cos(moveA) * sp * slowMul + e.knbx) * dt;
        e.y += (Math.sin(moveA) * sp * slowMul + e.knby) * dt;
        e.shootCd -= dt * lucid; // fire cadence dilates too — fewer shots while lucid
        if (e.shootCd <= 0 && D < rangedDef.range * 1.15 && e.slowT <= 0) {
          e.shootCd = rangedDef.cd * rand(0.85, 1.15);
          audio.enemyShot(this.panOf(e.x));
          const shots = rangedDef.shots;
          for (let si = 0; si < shots; si++) {
            const sa = a + (shots > 1 ? (si - (shots - 1) / 2) * 0.28 : rand(-0.05, 0.05));
            this.shootBossProj(e.x, e.y - 8, sa, rangedDef.projSpeed, 5, e.dmg, 7, e.color);
          }
        }
      } else if (!(e.boss && e.bossFire && e.bossFire.hold > 0)) {
        // (a slamming Colossus is rooted — bossFire.hold pins it in place)
        e.x += (Math.cos(a + wob * 0.3) * e.speed * slowMul + e.knbx) * dt;
        e.y += (Math.sin(a + wob * 0.3) * e.speed * slowMul + e.knby) * dt;
      }
      e.knbx *= Math.pow(0.02, dt);
      e.knby *= Math.pow(0.02, dt);
      // melee: each enemy strikes on its own cooldown (no shared i-frames), so
      // several foes can land hits independently. Reach is a small bonus beyond
      // the touching distance, larger for later/bigger types.
      if (e.meleeCd > 0) e.meleeCd -= dt * lucid; // swings come slower while lucid
      if (e.meleeAnim > 0) e.meleeAnim -= dt;
      // hard-frozen foes (Absolute Winter, sigil sleep, comet stun — slow ≥ 0.9)
      // can't strike; ordinary chills only slow movement. Ranged fire is gated
      // on any slow already (see the shootCd check above).
      const frozen = e.slowT > 0 && e.slow >= 0.9;
      if (e.meleeCd <= 0 && !frozen) {
        const reach = e.radius + PLAYER_HURT_R + e.meleeReach;
        if (dist2(e.x, e.y, p.x, p.y + PLAYER_HURT_DY) < reach * reach) {
          e.meleeCd = e.meleeBaseCd;
          e.meleeAnim = MELEE_ANIM_DUR; // quick, readable lunge + slash
          this.meleeStrike(e);
        }
      }
      // personal space: keep enemies out of the player's body so they don't
      // stack on the player's centre while attacking. They settle in a ring at
      // (e.radius + PLAYER_HURT_R), which is still inside melee reach, so they
      // keep striking from the ring. Bosses bulldoze through (not pushed).
      if (!e.boss) {
        const pushR = e.radius + PLAYER_HURT_R;
        const pcy = p.y + PLAYER_HURT_DY;
        const ddp = dist2(e.x, e.y, p.x, pcy);
        if (ddp < pushR * pushR && ddp > 0.01) {
          const Dp = Math.sqrt(ddp);
          const k = pushR - Dp; // intrusion depth; hard block (full correction)
          e.x += ((e.x - p.x) / Dp) * k;
          e.y += ((e.y - pcy) / Dp) * k;
        }
      }
      // boss bullet-hell
      if (e.boss) this.updateBossFire(e, dt);
      // ambient wisps off elites & boss
      if ((e.elite || e.boss) && Math.random() < 0.3) {
        this.particles.spawn({ x: e.x + rand(-e.radius, e.radius), y: e.y + rand(-e.radius, e.radius), vx: rand(-20, 20), vy: rand(-40, -10), life: rand(0.4, 1), size: rand(2, 5), color: e.boss ? '#c48cff' : '#ff5a7a', mode: 'glow', drag: 0.97 });
      }
    }
    // light separation between enemies (cheap, sampled)
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead) continue;
      const j = (i + 1 + ((Math.random() * 4) | 0)) % es.length;
      const o = es[j];
      if (o === e || o.dead) continue;
      const dd = dist2(e.x, e.y, o.x, o.y);
      const minD = e.radius + o.radius;
      if (dd < minD * minD && dd > 0.01) {
        const D = Math.sqrt(dd);
        const push = (minD - D) * 0.5;
        const ux = (e.x - o.x) / D, uy = (e.y - o.y) / D;
        e.x += ux * push; e.y += uy * push;
        o.x -= ux * push; o.y -= uy * push;
      }
    }
    // cull dead enemies and ones that drift far off-screen — but never a boss
    for (let i = 0; i < this.enemies.length;) {
      const e = this.enemies[i];
      if (e.dead || (!e.boss && dist2(e.x, e.y, p.x, p.y) >= 2600 * 2600)) {
        this.freeSlots.push(e.slot);
        this.enemyPool.release(e);
        swapRemove(this.enemies, i);
        continue;
      }
      i++;
    }

    // index the settled enemy positions for the query passes below
    this.grid.rebuild(this.enemies);

    // boss projectiles
    // lucid slows every hostile bullet mid-air (reflected shots are the player's
    // now, so they keep their speed and still hunt the horde)
    const bulletDt = this.lucidT > 0 ? dt * LUCID_SLOW : dt;
    for (let i = 0; i < this.bossProjectiles.length;) {
      const bp = this.bossProjectiles[i];
      bp.px = bp.x; bp.py = bp.y;
      bp.life -= dt;
      const bdt = bp.reflected ? dt : bulletDt;
      // Colossus stones: slow off the hand, gathering speed as they travel
      if (bp.accel > 0 && !bp.reflected) {
        const spd = Math.hypot(bp.vx, bp.vy);
        if (spd > 0 && spd < bp.maxSpd) {
          const k = Math.min(bp.maxSpd, spd + bp.accel * bdt) / spd;
          bp.vx *= k; bp.vy *= k;
        }
      }
      bp.x += bp.vx * bdt;
      bp.y += bp.vy * bdt;
      if (bp.reflected) {
        // Mirror Waltz: the returned shot bursts on the first foe it meets
        let struck: Enemy | null = null;
        this.grid.queryCircle(bp.x, bp.y, bp.r + 40, (e) => {
          if (!struck && dist2(bp.x, bp.y, e.x, e.y) < (e.radius + bp.r) ** 2) struck = e;
        });
        if (bp.life > 0 && struck) {
          this.damageEnemy(struck, bp.dmg * 3, '#7dffb0', 'nature');
          bp.life = 0;
        }
      } else if (bp.life > 0 && dist2(bp.x, bp.y, p.x, p.y + PLAYER_HURT_DY) < (PLAYER_HURT_R + bp.r) ** 2 && p.iframes <= 0) {
        this.hurtPlayer(bp.dmg);
        bp.life = 0;
      }
      if (bp.life <= 0) {
        this.bossProjPool.release(bp);
        swapRemove(this.bossProjectiles, i);
        continue;
      }
      i++;
    }

    // projectiles
    this.updateProjectiles(dt);

    // zones
    this.updateZones(dt);

    // beams — lances flash once per foe; the Sleepless Eye's gaze follows the
    // player and re-hits on a cadence; Kaleidoscope rays are brief refractions
    for (let i = 0; i < this.beams.length;) {
      const b = this.beams[i];
      b.pa = b.a;
      b.life -= dt;
      if (b.follow) { b.x = p.x; b.y = p.y - 20; }
      if (b.sweep) b.a += b.sweep * dt;
      const gaze = b.kind === 'gaze';
      const ray = b.kind === 'ray';
      const hitCol = gaze ? '#fff7c9' : ray ? '#f4c9ff' : '#fff3b8';
      const ca = Math.cos(b.a), sa = Math.sin(b.a);
      const mx2 = b.x + ca * b.len * 0.5, my2 = b.y + sa * b.len * 0.5;
      this.grid.queryCircle(mx2, my2, b.len * 0.5 + b.w * 0.5 + 40, (e) => {
        if (b.hitT) { if (!b.hitT.ready(e.slot, this.t)) return; }
        else if (b.hit!.has(e.slot)) return;
        const ex = e.x - b.x, ey = e.y - b.y;
        const proj = ex * ca + ey * sa;
        if (proj < 0 || proj > b.len) return;
        const perp = Math.abs(-ex * sa + ey * ca);
        if (perp < b.w * 0.5 + e.radius) {
          if (b.hitT) {
            b.hitT.set(e.slot, this.t + b.int);
            // Blinding Light: the gaze's FIRST touch staggers (mask tracks it)
            if (b.stun && b.hit && !b.hit.has(e.slot)) {
              b.hit.mark(e.slot);
              if (!e.boss && this.hardCC(e, CC_HIT)) { e.slow = 0.92; e.slowT = 0.35; }
            }
          } else b.hit!.mark(e.slot);
          this.damageEnemy(e, b.dmg, hitCol, ray ? 'cosmic' : 'light');
          const nSpark = ray ? 4 : 8;
          for (let k = 0; k < nSpark; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-140, 140), vy: rand(-140, 140), life: rand(0.25, 0.55), size: rand(2, 5), color: hitCol, mode: 'star', rotV: rand(-8, 8), drag: 0.88 });
        }
      });
      if (!ray) {
        for (let k = 0; k < 4; k++) {
          const dPos = rand(0, b.len);
          this.particles.spawn({ x: b.x + ca * dPos + rand(-6, 6), y: b.y + sa * dPos + rand(-6, 6), vx: rand(-20, 20), vy: rand(-40, -5), life: rand(0.4, 0.9), size: rand(1.5, 4), color: gaze ? pick(['#fff7c9', '#ffb3f2']) : pick(['#fff3b8', '#bcd9ff']), mode: 'glow', drag: 0.96 });
        }
      }
      // Aurora Crown: the wheeling gaze paints fading light on the ground
      if (gaze && b.linger && Math.random() < dt * 1.6) {
        const dPos = rand(b.len * 0.25, b.len * 0.9);
        this.spawnScorch(b.x + ca * dPos, b.y + sa * dPos, b.w * 1.4, b.dmg * 0.3, '#ffd9a0', '#ffb3f2');
      }
      if (b.life <= 0) {
        if (b.hit) { maskPool.release(b.hit); b.hit = null; }
        if (b.hitT) { timerPool.release(b.hitT); b.hitT = null; }
        this.beamPool.release(b);
        swapRemove(this.beams, i);
        continue;
      }
      i++;
    }

    // bolts fade
    for (let i = 0; i < this.bolts.length;) {
      const b = this.bolts[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.boltPool.release(b);
        swapRemove(this.bolts, i);
        continue;
      }
      i++;
    }

    // Confluence: nearby essence orbs braid together into dreamshards
    if (this.meta.gemMerge) {
      this.mergeT -= dt;
      if (this.mergeT <= 0) {
        this.mergeT = 0.35;
        const MERGE_R = 60;
        const gs = this.gems;
        for (let i = 0; i < gs.length; i++) {
          const a = gs[i];
          if (a.dead || a.heal || a.shard) continue;
          for (let j = i + 1; j < gs.length; j++) {
            const b = gs[j];
            if (b.dead || b.heal || b.shard) continue;
            if (dist2(a.x, a.y, b.x, b.y) < MERGE_R * MERGE_R) {
              a.v += b.v;
              a.merged = true;
              a.big = a.big || b.big;
              b.dead = true;
              this.particles.spawn({ x: a.x, y: a.y, life: 0.35, size: 12, color: '#cbb6ff', mode: 'glow', drag: 1 });
            }
          }
        }
      }
      // dreamshards exert a gentle pull, so the braid keeps growing
      for (const g of this.gems) {
        if (!g.merged || g.dead) continue;
        for (const o of this.gems) {
          if (o === g || o.dead || o.heal || o.shard || o.merged) continue;
          const dd = dist2(g.x, g.y, o.x, o.y);
          if (dd < 100 * 100 && dd > 1) {
            const D = Math.sqrt(dd);
            o.x += ((g.x - o.x) / D) * 70 * dt;
            o.y += ((g.y - o.y) / D) * 70 * dt;
          }
        }
      }
    }

    // gems
    const mr = this.magnetR();
    for (let i = 0; i < this.gems.length;) {
      const g = this.gems[i];
      if (g.dead) {
        this.gemPool.release(g);
        swapRemove(this.gems, i);
        continue;
      }
      g.px = g.x; g.py = g.y;
      g.ph += dt * 4;
      const dd = dist2(g.x, g.y, p.x, p.y);
      if (dd < mr * mr) {
        const D = Math.sqrt(dd) || 1;
        const pullSp = 260 + (mr - D) * 6;
        g.x += ((p.x - g.x) / D) * pullSp * dt;
        g.y += ((p.y - g.y) / D) * pullSp * dt;
      }
      if (dd < 26 * 26 && !p.dead) {
        g.dead = true;
        if (g.shard) {
          this.shardsEarned++;
          audio.shard();
          this.spawnText(p.x, p.y - 44, '+1 nightmare shard', '#ff7ab0', 1.2, -36, 15);
        } else if (g.heal) {
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
          audio.heal();
          this.spawnText(p.x, p.y - 40, '+life', '#7dffb0', 0.8, -40, 14);
        } else {
          this.gainXp(g.v);
          audio.gem();
        }
        for (let k = 0; k < 8; k++) this.particles.spawn({ x: g.x, y: g.y, vx: rand(-90, 90), vy: rand(-120, -20), life: rand(0.3, 0.6), size: rand(2, 4), color: g.shard ? '#ff5a7a' : g.heal ? '#7dffb0' : '#7ff5ff', mode: 'glow', drag: 0.9 });
      }
      i++;
    }
    if (this.gems.length > 400) {
      const excess = this.gems.length - 400;
      for (let i = 0; i < excess; i++) this.gemPool.release(this.gems[i]);
      this.gems.splice(0, excess);
    }

    // fallen stars (map pickups)
    this.starTimer -= dt;
    if (this.starTimer <= 0) {
      this.starTimer = rand(75, 110) * (this.relics.has('cartographer') ? 0.5 : 1);
      const a = rand(0, TAU);
      this.pickups.push({
        dead: false,
        x: p.x + Math.cos(a) * rand(650, 900), y: p.y + Math.sin(a) * rand(650, 900),
        life: 20, ph: rand(0, TAU), kind: pick(['heal', 'gems', 'dust'] as const),
      });
      audio.starFallen();
      this.setBanner('A STAR HAS FALLEN NEARBY', '#7ff5ff');
    }

    // whispering altars: up to three bargains per dream
    if (this.altarsLeft > 0) {
      this.altarTimer -= dt;
      if (this.altarTimer <= 0) {
        this.altarTimer = rand(140, 190) * (this.relics.has('cartographer') ? 0.6 : 1);
        this.altarsLeft--;
        const aa = rand(0, TAU);
        this.pickups.push({
          dead: false,
          x: p.x + Math.cos(aa) * rand(550, 800), y: p.y + Math.sin(aa) * rand(550, 800),
          life: 30, ph: rand(0, TAU), kind: 'altar',
        });
        audio.starFallen();
        this.setBanner('A WHISPERING ALTAR RISES', '#c48cff');
      }
    }

    // lucid moments: for a few breaths the dream obeys you — the horde slows
    // and every mote of essence burns twice as bright
    this.lucidTimer -= dt;
    if (this.lucidTimer <= 0) {
      this.lucidTimer = rand(150, 220);
      this.lucidT = LUCID_DUR;
      this.flash = { color: '125,245,255', a: 0.3 };
      this.setBanner('THE DREAM TURNS LUCID', '#7ff5ff', 3.4, 30);
      audio.bonus();
    }
    this.lucidT = Math.max(0, this.lucidT - dt);

    // the director: every few seconds, read the room and lean on the scales.
    // Cruising (healthy, field nearly clear) swells the tide; drowning
    // (bleeding, or the horde piling past the floor) eases it. Bounded so it
    // spices pacing without erasing the difficulty curve or the banes.
    this.dirTimer -= dt;
    if (this.dirTimer <= 0) {
      this.dirTimer = 4;
      const hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 1;
      const alive = this.enemies.length;
      const floorNow = Math.max(1, this.wave.floor);
      if (hpFrac > 0.7 && alive < floorNow * 0.65) this.intensity = Math.min(1.45, this.intensity + 0.06);
      else if (hpFrac < 0.4 || alive > floorNow * 1.25) this.intensity = Math.max(0.72, this.intensity - 0.09);
      else this.intensity += (1 - this.intensity) * 0.12;
    }

    // a boss fell earlier: open the relic choice once the floor is free
    if (this.relicQueue > 0 && !this.levelUpActive && !this.pactActive && !this.relicChoiceActive && !p.dead) {
      this.offerRelics();
    }

    for (let i = 0; i < this.pickups.length;) {
      const s = this.pickups[i];
      s.life -= dt;
      s.ph += dt * 3;
      if (!s.dead && !p.dead && dist2(s.x, s.y, p.x, p.y) < 34 * 34) {
        s.dead = true;
        if (s.kind === 'altar') {
          // the altar whispers its bargain — the dream holds its breath
          this.pactCurrent = PACTS[(Math.random() * PACTS.length) | 0];
          this.pactActive = true;
          this.paused = true;
          audio.levelUp();
          this.hooks.onPact(this.pactCurrent);
          for (let k = 0; k < 30; k++) {
            const a2 = rand(0, TAU);
            this.particles.spawn({ x: s.x, y: s.y, vx: Math.cos(a2) * rand(60, 240), vy: Math.sin(a2) * rand(60, 240), life: rand(0.4, 0.9), size: rand(2, 5), color: '#c48cff', color2: '#ff5a7a', mode: 'rune', rotV: rand(-4, 4), drag: 0.9 });
          }
          swapRemove(this.pickups, i);
          continue;
        }
        audio.starPickup();
        if (s.kind === 'heal') {
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.35);
          this.spawnText(p.x, p.y - 44, '+life', '#7dffb0', 1, -40, 16);
        } else if (s.kind === 'gems') {
          const v = Math.max(2, Math.round(3 * this.diff.hpMul));
          for (let k = 0; k < 10; k++) this.spawnGem(s.x + rand(-60, 60), s.y + rand(-60, 60), v, true, false, false, rand(0, TAU));
        } else {
          const d = this.dustReward(1);
          this.bonusDust += d;
          this.spawnText(p.x, p.y - 44, `+${d} stardust`, '#ffd27a', 1, -40, 16);
        }
        for (let k = 0; k < 40; k++) {
          const a2 = rand(0, TAU);
          this.particles.spawn({ x: s.x, y: s.y, vx: Math.cos(a2) * rand(80, 320), vy: Math.sin(a2) * rand(80, 320), life: rand(0.4, 0.9), size: rand(2, 5), color: '#7ff5ff', color2: '#ffd27a', mode: 'star', rotV: rand(-6, 6), drag: 0.9 });
        }
      }
      if (s.dead || s.life <= 0) { swapRemove(this.pickups, i); continue; }
      i++;
    }

    // banner
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }

    // texts
    for (let i = 0; i < this.texts.length;) {
      const tx = this.texts[i];
      tx.life -= dt;
      tx.y += tx.vy * dt;
      if (tx.life <= 0) {
        this.textPool.release(tx);
        swapRemove(this.texts, i);
        continue;
      }
      i++;
    }

    this.shake = Math.max(0, this.shake - dt * 30);
    if (this.flash) { this.flash.a -= dt * 1.2; if (this.flash.a <= 0) this.flash = null; }

    // hud sync ~10hz; the same cadence feeds the adaptive music its picture of
    // the battle (crowd pressure opens the pad, a live boss darkens the chord,
    // low HP brings up the heartbeat)
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.pushHud();
      let bossAlive = false;
      for (const e of this.enemies) {
        if (e.boss && !e.dead) { bossAlive = true; break; }
      }
      const hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 1;
      audio.gameState(
        Math.min(1, this.enemies.length / 130) * 0.75 + (bossAlive ? 0.35 : 0),
        hpFrac < 0.42 && !p.dead ? 1 - hpFrac / 0.42 : 0,
        bossAlive,
      );
    }
  }

  // -------------------------------------------------------------- projectiles
  private updateProjectiles(dt: number) {
    for (let i = 0; i < this.projectiles.length;) {
      const pr = this.projectiles[i];
      pr.px = pr.x; pr.py = pr.y;
      if (pr.kind === 'arcane') {
        pr.life -= dt;
        // target validity: object may be dead or recycled (uid changed)
        if (!pr.target || pr.target.dead || pr.target.uid !== pr.targetUid) {
          this.setProjTarget(pr, this.nearestEnemy(pr.x, pr.y, 520));
        }
        if (pr.target) {
          const want = Math.atan2(pr.target.y - pr.y, pr.target.x - pr.x);
          const cur = Math.atan2(pr.vy, pr.vx);
          const diff = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
          const na = cur + clamp(diff, -pr.turn * dt, pr.turn * dt);
          const sp = Math.min(pr.speed, Math.hypot(pr.vx, pr.vy) + 800 * dt);
          pr.vx = Math.cos(na) * sp;
          pr.vy = Math.sin(na) * sp;
        }
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-10, 10), vy: rand(-10, 10), life: 0.35, size: rand(3, 6), endSize: 0.5, color: '#b48cff', color2: '#e6d1ff', mode: 'glow' });
        // grid-routed hit test (was a full enemies scan)
        let struckEnemy: Enemy | null = null;
        this.grid.queryCircle(pr.x, pr.y, pr.r + 60, (e) => {
          if (struckEnemy || pr.life <= 0) return;
          if (e.uid === pr.struckA || e.uid === pr.struckB) return;
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) struckEnemy = e;
        });
        if (struckEnemy) {
          const e = struckEnemy as Enemy;
          this.damageEnemy(e, pr.dmg, '#d9beff');
          for (let k = 0; k < 10; k++) this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-170, 170), vy: rand(-170, 170), life: rand(0.2, 0.5), size: rand(2, 4), color: '#e6d1ff', mode: 'star', rotV: rand(-6, 6), drag: 0.86 });
          // Arcane Torrent: splinter into two seeking shards
          if (pr.splinter) {
            for (let k = 0; k < 2; k++) {
              const sa = rand(0, TAU);
              const sub = this.newProj('arcane');
              sub.x = pr.x; sub.y = pr.y; sub.px = pr.x; sub.py = pr.y;
              sub.vx = Math.cos(sa) * pr.speed * 0.6;
              sub.vy = Math.sin(sa) * pr.speed * 0.6;
              sub.speed = pr.speed;
              sub.dmg = pr.dmg * 0.4;
              sub.life = 0.9; sub.r = 5;
              sub.turn = 9;
              this.setProjTarget(sub, this.nearestEnemy(pr.x, pr.y, 420, e));
              this.projectiles.push(sub);
            }
          }
          // Splinter Point: pass through and hunt a fresh target
          if (pr.pierce > 0) {
            pr.pierce--;
            if (pr.struckA < 0) pr.struckA = e.uid; else pr.struckB = e.uid;
            this.setProjTarget(pr, this.nearestEnemy(pr.x, pr.y, 520, e));
          } else {
            pr.life = 0;
          }
        }
      } else if (pr.kind === 'ember') {
        pr.t += dt;
        const f = Math.min(1, pr.t / pr.dur);
        pr.x = pr.sx + (pr.tx - pr.sx) * f;
        pr.y = pr.sy + (pr.ty - pr.sy) * f - Math.sin(f * Math.PI) * pr.arc;
        this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-14, 14), vy: rand(-10, 40), life: rand(0.25, 0.55), size: rand(3, 7), endSize: 1, color: '#ffd27a', color2: '#ff8c5a', mode: 'glow' });
        if (f >= 1) {
          pr.life = 0;
          this.explode(pr.tx, pr.ty, pr.range, pr.dmg);
          if (pr.hasBurn) this.spawnScorch(pr.tx, pr.ty, pr.range * 0.75, pr.burnDps, pr.burnC1, pr.burnC2);
        } else pr.life = 1;
      } else if (pr.kind === 'comet') {
        if (!pr.hasX0) { pr.hasX0 = true; pr.x0 = pr.x - pr.tx; pr.y0 = pr.y - pr.ty; }
        pr.t += dt;
        const f = Math.min(1, pr.t / pr.dur);
        pr.x = pr.tx + pr.x0 * (1 - f);
        pr.y = pr.ty + pr.y0 * (1 - f);
        this.particles.spawn({ x: pr.x + rand(-4, 4), y: pr.y + rand(-4, 4), vx: rand(-15, 15), vy: rand(-30, 10), life: rand(0.3, 0.6), size: rand(3, 7), endSize: 1, color: '#ffb3f2', color2: '#8a7bff', mode: 'glow' });
        if (f >= 1) {
          pr.life = 0;
          this.explode(pr.tx, pr.ty, pr.range, pr.dmg, { ring: '#ffb3f2', core: '#ffffff', sparks: ['#ffb3f2', '#c48cff', '#8a7bff'], text: '#ffc9f5' });
          // Meteoric Mass: the impact leaves survivors reeling
          if (pr.stun) {
            this.grid.queryCircle(pr.tx, pr.ty, pr.range + 60, (e) => {
              if (e.boss) return;
              if (dist2(pr.tx, pr.ty, e.x, e.y) < (pr.range + e.radius) ** 2) { e.slow = Math.max(e.slow, 0.9); e.slowT = Math.max(e.slowT, 0.7); }
            });
          }
          if (pr.hasBurn) this.spawnScorch(pr.tx, pr.ty, pr.range * 0.75, pr.burnDps, pr.burnC1, pr.burnC2);
        } else pr.life = 1;
      } else if (pr.kind === 'fang') {
        pr.life -= dt;
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        if (Math.random() < 0.7) this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-12, 12), vy: rand(-12, 12), life: 0.3, size: rand(3, 6), endSize: 0.5, color: '#8a5cd9', color2: '#20123d', mode: 'smoke' });
        this.grid.queryCircle(pr.x, pr.y, pr.r + 45, (e) => {
          if (pr.hit!.has(e.slot)) return;
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
            pr.hit!.mark(e.slot);
            this.damageEnemy(e, pr.dmg, '#c9a4ff', 'shadow');
            if (pr.chill && !e.boss) { e.slow = Math.max(e.slow, 0.35); e.slowT = Math.max(e.slowT, 1); }
            for (let k = 0; k < 6; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-130, 130), vy: rand(-130, 130), life: rand(0.2, 0.45), size: rand(2, 4), color: '#8a5cd9', mode: 'glow', drag: 0.86 });
          }
        });
      } else if (pr.kind === 'iceshard') {
        pr.life -= dt;
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        if (Math.random() < 0.8) this.particles.spawn({ x: pr.x, y: pr.y, vx: rand(-10, 10), vy: rand(-10, 10), life: rand(0.2, 0.4), size: rand(2, 4.5), endSize: 0.5, color: Math.random() < 0.5 ? '#e8fbff' : '#8fe8ff', mode: 'shard', rotV: rand(-8, 8), drag: 0.9 });
        this.grid.queryCircle(pr.x, pr.y, pr.r + 45, (e) => {
          if (pr.life <= 0) return; // already spent this frame
          if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
            this.damageEnemy(e, pr.dmg, '#bff1ff', 'frost');
            if (pr.chill && !e.boss) { e.slow = Math.max(e.slow, 0.4); e.slowT = Math.max(e.slowT, 1.4); }
            for (let k = 0; k < 7; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-140, 140), vy: rand(-140, 140), life: rand(0.2, 0.45), size: rand(2, 4), color: '#cdf3ff', mode: 'shard', rotV: rand(-9, 9), drag: 0.85 });
            pr.life = 0; // a single icy bite, then it shatters
          }
        });
      } else if (pr.kind === 'glaive') {
        pr.life -= dt;
        pr.spin += dt * 14;
        const p2 = this.player;
        if (!pr.returning) {
          pr.x += Math.cos(pr.a) * pr.speed * dt;
          pr.y += Math.sin(pr.a) * pr.speed * dt;
          pr.travelled += pr.speed * dt;
          if (pr.travelled >= pr.range) pr.returning = true;
        } else {
          const D = Math.hypot(p2.x - pr.x, p2.y - pr.y - 20) || 1;
          if (D < 30) {
            pr.life = 0;
            // Star Sovereign: the returning glaive bursts into stardust
            if (pr.evolved) this.explode(p2.x, p2.y - 20, 110, pr.dmg * 1.2, { ring: '#9fd8ff', core: '#e8f6ff', sparks: ['#9fd8ff', '#e8f6ff', '#ffffff'], text: '#bfe4ff', quiet: true }, 'cosmic');
          } else {
            pr.x += ((p2.x - pr.x) / D) * pr.speed * 1.15 * dt;
            pr.y += ((p2.y - 20 - pr.y) / D) * pr.speed * 1.15 * dt;
          }
        }
        if (pr.life > 0) {
          if (Math.random() < 0.9) this.particles.spawn({ x: pr.x + rand(-10, 10), y: pr.y + rand(-10, 10), vx: rand(-40, 40), vy: rand(-40, 40), life: rand(0.35, 0.7), size: rand(6, 11), endSize: 1, color: '#e8f6ff', color2: '#9fd8ff', mode: 'shard', rotV: rand(-10, 10), drag: 0.93 });
          this.grid.queryCircle(pr.x, pr.y, pr.r + 45, (e) => {
            if (!pr.hitCd!.ready(e.slot, this.t)) return;
            if (dist2(pr.x, pr.y, e.x, e.y) < (e.radius + pr.r) ** 2) {
              pr.hitCd!.set(e.slot, this.t + pr.hitInt);
              this.damageEnemy(e, pr.dmg, '#bfe4ff', 'cosmic');
              for (let k = 0; k < 5; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-120, 120), vy: rand(-120, 120), life: rand(0.2, 0.4), size: rand(2, 4), color: '#bfe4ff', mode: 'star', rotV: rand(-6, 6), drag: 0.88 });
            }
          });
        }
      }

      if (pr.life <= 0) {
        this.freeProjectile(pr);
        swapRemove(this.projectiles, i);
        continue;
      }
      i++;
    }
  }

  private spawnScorch(x: number, y: number, r: number, dps: number, c1: string, c2: string) {
    const z = this.zonePool.acquire();
    this.resetZone(z, 'scorch', x, y);
    z.r = r; z.pr = r;
    z.life = 2.5; z.maxLife = 2.5;
    z.dps = dps;
    z.tick = 0;
    z.c1 = c1; z.c2 = c2;
    z.seed = rand(0, TAU);
    this.zones.push(z);
  }

  // -------------------------------------------------------------- zones
  // Apply hard CC (pull/freeze/sleep/knock) through the saturation gate. Trash
  // and bosses pass straight through (bosses are gated separately at each call
  // site); elites/golden/ranged build saturation and, once full, shrug free for
  // a moment so overlapping rifts and blooms can't hold them forever.
  private hardCC(e: Enemy, amount: number): boolean {
    if (e.boss || !(e.elite || e.golden || e.ranged)) return true;
    if (e.ccImmT > 0) return false;
    e.ccSat += amount;
    if (e.ccSat >= 1) {
      e.ccSat = 0;
      e.ccImmT = CC_IMMUNE;
      e.slowT = 0; // break free of whatever holds it this instant
      this.particles.spawn({ x: e.x, y: e.y, life: 0.4, size: e.radius * 2.4, color: '#ffffff', mode: 'ring' });
    }
    return true;
  }

  private updateZones(dt: number) {
    const p = this.player;
    for (let i = 0; i < this.zones.length;) {
      const z = this.zones[i];
      z.px = z.x; z.py = z.y; z.pr = z.r;
      z.life -= dt;
      if (z.delay && z.delay > 0) { z.delay -= dt; z.life += dt; i++; continue; }
      if (z.kind === 'frostwave') {
        const f = 1 - z.life / z.maxLife;
        z.r = 10 + (z.maxR - 10) * f;
        this.grid.queryCircle(z.x, z.y, z.r, (e) => {
          if (z.hit!.has(e.slot)) return;
          if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) {
            z.hit!.mark(e.slot);
            this.damageEnemy(e, z.dmg, '#bff1ff', 'frost');
            if (!e.boss) {
              // Absolute Winter freezes solid (hard CC); an ordinary chill only
              // slows and never saturates
              if (z.slow < 0.9 || this.hardCC(e, CC_HIT)) {
                e.slow = z.slow;
                e.slowT = z.slowDur;
              }
            } else if (z.bossChill) {
              // Creeping Cold: even bosses feel the bloom, at half strength
              e.slow = z.slow * 0.5;
              e.slowT = z.slowDur;
            }
            for (let k = 0; k < 6; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-60, 60), vy: rand(-90, -20), life: rand(0.4, 0.8), size: rand(3, 6), color: '#bff1ff', mode: 'shard', rotV: rand(-4, 4), drag: 0.93 });
          }
        });
      } else if (z.kind === 'rift') {
        z.spin += dt * 3.2;
        z.tick -= dt;
        // Event Horizon: the rift collapses in a burst when it closes
        if (z.evolved && z.life <= 0 && !z.boomed) {
          z.boomed = true;
          this.explode(z.x, z.y, z.r * 1.3, z.dps * 3, { ring: '#9a5cff', core: '#e6d1ff', sparks: ['#9a5cff', '#ff9ad5', '#c9a4ff'], text: '#c9a4ff', quiet: true }, 'shadow');
        }
        for (let k = 0; k < 3; k++) {
          const a = rand(0, TAU);
          const R = z.r * rand(0.9, 1.4);
          const px2 = z.x + Math.cos(a) * R, py2 = z.y + Math.sin(a) * R;
          this.particles.spawn({ x: px2, y: py2, vx: (z.x - px2) * 1.6 + -Math.sin(a) * 90, vy: (z.y - py2) * 1.6 + Math.cos(a) * 90, life: rand(0.4, 0.8), size: rand(2, 5), color: Math.random() < 0.5 ? '#9a5cff' : '#ff9ad5', mode: 'glow', drag: 0.97 });
        }
        this.grid.queryCircle(z.x, z.y, z.r * 1.6, (e) => {
          if (e.boss && !z.bossPull) return;
          const dd = dist2(z.x, z.y, e.x, e.y);
          if (dd < (z.r * 1.6) ** 2 && dd > 4) {
            if (!this.hardCC(e, dt * CC_PULL_RATE)) return; // saturated: it claws free
            const D = Math.sqrt(dd);
            const pull = z.pull * (e.boss ? 0.35 : 1);
            e.x += ((z.x - e.x) / D) * pull * dt;
            e.y += ((z.y - e.y) / D) * pull * dt;
          }
        });
        if (z.tick <= 0) {
          z.tick = 0.25;
          this.grid.queryCircle(z.x, z.y, z.r, (e) => {
            if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) this.damageEnemy(e, z.dps * 0.25, '#c9a4ff', 'shadow');
          });
        }
      } else if (z.kind === 'nebula') {
        if (z.evolved) {
          // Genesis Cloud follows its maker
          const D = Math.hypot(p.x - z.x, p.y - z.y) || 1;
          if (D > 40) { z.x += ((p.x - z.x) / D) * 42 * dt; z.y += ((p.y - z.y) / D) * 42 * dt; }
        } else {
          z.x += z.dvx * dt;
          z.y += z.dvy * dt;
        }
        z.tick -= dt;
        for (let k = 0; k < 2; k++) {
          const a = rand(0, TAU), R = z.r * Math.sqrt(Math.random());
          this.particles.spawn({ x: z.x + Math.cos(a) * R, y: z.y + Math.sin(a) * R, vx: rand(-14, 14), vy: rand(-18, -4), life: rand(0.5, 1.1), size: rand(1.5, 4), color: pick(['#c48cff', '#ff9ad5', '#ffd9f2']), mode: Math.random() < 0.3 ? 'star' : 'glow', rotV: rand(-3, 3), drag: 0.97 });
        }
        if (Math.random() < 0.8) {
          const a = rand(0, TAU);
          this.particles.spawn({ x: z.x + Math.cos(a) * z.r * rand(0.93, 1.0), y: z.y + Math.sin(a) * z.r * rand(0.93, 1.0), vx: -Math.sin(a) * 30, vy: Math.cos(a) * 30, life: rand(0.6, 1.2), size: rand(1.2, 2.6), color: pick(['#e3bfff', '#ffd9f2']), mode: 'glow', drag: 0.99 });
        }
        if (z.tick <= 0) {
          z.tick = 0.3;
          this.grid.queryCircle(z.x, z.y, z.r, (e) => {
            const dd = dist2(z.x, z.y, e.x, e.y);
            if (dd < z.r * z.r) {
              // Newborn Heart: the dense heart of the cloud burns double
              const coreMul = z.core && dd < (z.r * 0.45) ** 2 ? 2 : 1;
              this.damageEnemy(e, z.dps * 0.3 * coreMul, '#e3bfff', 'cosmic');
              // Whispering Mist: the cloud clings to those inside
              if (z.slowIn && !e.boss) { e.slow = Math.max(e.slow, z.slowIn / 100); e.slowT = Math.max(e.slowT, 0.5); }
            }
          });
        }
      } else if (z.kind === 'sigil') {
        if (z.life <= 0) {
          audio.sigilBoom(this.panOf(z.x));
          this.particles.spawn({ x: z.x, y: z.y, life: 0.45, size: z.r * 1.3, color: '#ffd27a', mode: 'ring' });
          for (let k = 0; k < 40; k++) {
            const a = rand(0, TAU);
            this.particles.spawn({ x: z.x, y: z.y, vx: Math.cos(a) * rand(60, 320), vy: Math.sin(a) * rand(60, 320), life: rand(0.3, 0.8), size: rand(2, 6), color: pick(['#ffd27a', '#b48cff', '#fff2cc']), mode: 'star', rotV: rand(-6, 6), drag: 0.88 });
          }
          this.grid.queryCircle(z.x, z.y, z.r + 60, (e) => {
            if (dist2(z.x, z.y, e.x, e.y) < (z.r + e.radius) ** 2) {
              this.damageEnemy(e, z.dmg, '#ffe9bd', 'light');
              if (!e.boss && this.hardCC(e, CC_HIT)) { e.slow = 0.92; e.slowT = z.sleepDur; }
            }
          });
          // The Great Seal sounds twice
          if (z.echo && !z.echoed) { z.echoed = true; z.life = 0.9; }
        }
      } else if (z.kind === 'scorch') {
        z.tick -= dt;
        if (Math.random() < 0.6) {
          const a = rand(0, TAU), R = z.r * Math.sqrt(Math.random());
          this.particles.spawn({ x: z.x + Math.cos(a) * R, y: z.y + Math.sin(a) * R, vx: rand(-8, 8), vy: rand(-45, -15), life: rand(0.3, 0.7), size: rand(2, 5), endSize: 0.5, color: z.c1, color2: z.c2, mode: 'glow', drag: 0.94 });
        }
        if (z.tick <= 0) {
          z.tick = 0.3;
          this.grid.queryCircle(z.x, z.y, z.r + 60, (e) => {
            if (dist2(z.x, z.y, e.x, e.y) < (z.r + e.radius) ** 2) this.damageEnemy(e, z.dps * 0.3, z.c2, 'fire');
          });
        }
      } else if (z.kind === 'novawave') {
        const f = 1 - z.life / z.maxLife;
        z.r = 10 + (z.maxR - 10) * f;
        this.grid.queryCircle(z.x, z.y, z.r, (e) => {
          if (z.hit!.has(e.slot)) return;
          if (dist2(z.x, z.y, e.x, e.y) < z.r * z.r) {
            z.hit!.mark(e.slot);
            this.damageEnemy(e, z.dmg, '#ffbfe4', 'shadow');
            if (!e.boss && this.hardCC(e, CC_HIT)) {
              const a = Math.atan2(e.y - z.y, e.x - z.x);
              e.knbx += Math.cos(a) * z.knock;
              e.knby += Math.sin(a) * z.knock;
            }
          }
        });
        // Dissolving Dusk: shots the wavefront sweeps past may be unmade.
        // The pr→r band means each projectile is rolled exactly once per wave.
        if (z.dissolve) {
          for (const bp of this.bossProjectiles) {
            if (bp.life <= 0 || bp.reflected) continue;
            const d = dist2(z.x, z.y, bp.x, bp.y);
            if (d > z.r * z.r || d <= z.pr * z.pr) continue;
            if (Math.random() * 100 >= z.dissolve) continue;
            bp.life = 0;
            // unmaking: a bright pop, a wide dusk ring, and a slow drift of
            // star-motes where the shot was
            this.particles.spawn({ x: bp.x, y: bp.y, life: 0.22, size: bp.r * 3.4, endSize: 1, color: '#ffffff', color2: '#ffbfe4', mode: 'glow', drag: 1 });
            this.particles.spawn({ x: bp.x, y: bp.y, life: 0.5, size: bp.r * 5.5, endSize: 2, color: '#ffbfe4', mode: 'ring' });
            for (let k = 0; k < 12; k++) {
              const a = rand(0, TAU);
              this.particles.spawn({ x: bp.x, y: bp.y, vx: bp.vx * 0.15 + Math.cos(a) * rand(30, 110), vy: bp.vy * 0.15 + Math.sin(a) * rand(30, 110) - 20, life: rand(0.45, 0.9), size: rand(3, 6.5), endSize: 0.5, color: Math.random() < 0.5 ? '#ffbfe4' : '#ffffff', color2: '#ffbfe4', mode: Math.random() < 0.35 ? 'star' : 'glow', rotV: rand(-6, 6), drag: 0.9 });
            }
          }
        }
      } else if (z.kind === 'lantern') {
        z.ph += dt * 4;
        z.tick -= dt;
        if (z.tick <= 0) {
          z.tick = z.int;
          let struck = false;
          this.grid.queryCircle(z.x, z.y, z.r + 60, (e) => {
            if (dist2(z.x, z.y, e.x, e.y) < (z.r + e.radius) ** 2) { this.damageEnemy(e, z.dmg, '#a8ffe8', 'light'); struck = true; }
          });
          // gentle heartbeat, not a floodlight: the pulse spans the whole
          // (AoE-scaled) zone and several lanterns tick at once, so it must
          // stay near-subliminal or the field strobes
          this.particles.spawn({ x: z.x, y: z.y, life: 0.5, size: z.r * 0.55, endSize: z.r * 0.85, color: 'rgba(168,255,232,0.18)', color2: 'rgba(74,217,196,0.06)', mode: 'glow', drag: 1 });
          if (struck) {
            for (let k = 0; k < 10; k++) {
              const a = rand(0, TAU);
              this.particles.spawn({ x: z.x, y: z.y, vx: Math.cos(a) * rand(60, 240), vy: Math.sin(a) * rand(60, 240), life: rand(0.25, 0.55), size: rand(2, 4), color: pick(['#a8ffe8', '#4ad9c4', '#7dffb0']), mode: 'glow', drag: 0.88 });
            }
          }
        }
        if (Math.random() < 0.5) this.particles.spawn({ x: z.x + rand(-6, 6), y: z.y - 10, vx: rand(-10, 10), vy: rand(-40, -14), life: rand(0.4, 0.9), size: rand(2, 4), color: '#a8ffe8', mode: 'glow', drag: 0.95 });
        // Kindly Lights: an expiring lantern sometimes leaves a healing spark
        if (z.life <= 0 && z.heal && Math.random() * 100 < z.heal) this.spawnGem(z.x, z.y, 0, false, true, false, 0);
      } else if (z.kind === 'serpent') {
        // steer toward the densest shoal, weaving as it swims. Re-target often
        // and turn briskly so the body actually rakes through the crowd.
        z.tick2 -= dt;
        if (z.tick2 <= 0) {
          z.tick2 = 0.28;
          const pt = this.densestPoint(220);
          if (pt) { z.ox = pt.x; z.oy = pt.y; }
          else { z.ox = z.x + rand(-320, 320); z.oy = z.y + rand(-320, 320); }
        }
        // if the head is right on its target, aim a little past it so the body
        // keeps sweeping through rather than stalling on the spot
        let aimX = z.ox, aimY = z.oy;
        if (dist2(z.x, z.y, z.ox, z.oy) < 60 * 60) {
          aimX = z.x + Math.cos(z.spin) * 200;
          aimY = z.y + Math.sin(z.spin) * 200;
        }
        const want = Math.atan2(aimY - z.y, aimX - z.x);
        const diff = ((want - z.spin + Math.PI * 3) % TAU) - Math.PI;
        z.spin += clamp(diff, -3.0 * dt, 3.0 * dt);
        const weave = Math.sin(this.t * 5 + z.seed) * 0.3;
        z.x += Math.cos(z.spin + weave) * z.knock * dt;
        z.y += Math.sin(z.spin + weave) * z.knock * dt;
        // record the head's swum path so the body bends through its turns
        z.pathAcc += Math.hypot(z.x - z.px, z.y - z.py);
        while (z.pathAcc >= SERPENT_PATH_SPACING) {
          z.pathAcc -= SERPENT_PATH_SPACING;
          z.pathHead = (z.pathHead + 1) % SERPENT_PATH_N;
          z.pathX[z.pathHead] = z.x; z.pathY[z.pathHead] = z.y;
        }
        // bow-wave bubbles off the head, wake behind
        if (Math.random() < 0.8) {
          this.particles.spawn({ x: z.x + rand(-6, 6), y: z.y + rand(-6, 6), vx: rand(-24, 24), vy: rand(-46, -12), life: rand(0.4, 0.9), size: rand(2, 4.5), color: Math.random() < 0.6 ? '#5ad7c9' : '#bffff4', mode: 'glow', drag: 0.94 });
        }
        z.tick -= dt;
        if (z.tick <= 0) {
          z.tick = 0.12;
          const R = z.r * z.grow;
          const L = z.maxR * z.grow;
          // sample the spine along the swum path, then test enemies against the
          // nearest body segment — so a curved tail rakes where it actually lies
          const segs = 8;
          const sx = this.serpSpineX, sy = this.serpSpineY;
          for (let i = 0; i <= segs; i++) {
            serpentPoint(z, z.x, z.y, (L * i) / segs, this.serpOut);
            sx[i] = this.serpOut.x; sy[i] = this.serpOut.y;
          }
          const mid = segs >> 1;
          this.grid.queryCircle(sx[mid], sy[mid], L * 0.6 + R + 70, (e) => {
            let best = Infinity;
            for (let i = 0; i < segs; i++) {
              const d = distToSeg(e.x, e.y, sx[i], sy[i], sx[i + 1], sy[i + 1]);
              if (d < best) best = d;
              if (best < R + e.radius) break;
            }
            if (best < R + e.radius) {
              this.damageEnemy(e, z.dps * 0.12, '#5ad7c9', 'frost');
              if (e.dead) {
                // Leviathan of Sleep grows; Salt Hunger lingers
                if (z.evolved) z.grow = Math.min(1.9, z.grow + 0.06);
                if (z.core) z.life = Math.min(z.maxLife, z.life + 0.5);
              }
            }
          });
        }
      } else if (z.kind === 'chimewave') {
        const f = 1 - z.life / z.maxLife;
        z.r = 12 + (z.maxR - 12) * f;
        const arc = z.ph; // 0 = full circle (the crescendo)
        this.grid.queryCircle(z.x, z.y, z.r, (e) => {
          if (z.hit!.has(e.slot)) return;
          if (dist2(z.x, z.y, e.x, e.y) >= z.r * z.r) return;
          // ordinary tolls only strike within their wedge of the hour
          if (arc > 0) {
            let d = Math.atan2(e.y - z.y, e.x - z.x) - z.spin;
            d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to [-PI, PI]
            if (Math.abs(d) > arc) return;
          }
          z.hit!.mark(e.slot);
          this.damageEnemy(e, z.dmg, '#ffd9a0');
          // The Last Hour / Struck Silver: the crescendo holds them still
          if (z.sleepDur > 0 && !e.boss && !e.dead && this.hardCC(e, CC_HIT)) {
            e.slow = 0.92;
            e.slowT = Math.max(e.slowT, z.sleepDur);
          }
          for (let k = 0; k < 4; k++) this.particles.spawn({ x: e.x, y: e.y, vx: rand(-100, 100), vy: rand(-120, -20), life: rand(0.25, 0.5), size: rand(2, 4), color: '#ffd9a0', mode: 'star', rotV: rand(-6, 6), drag: 0.9 });
        });
      } else if (z.kind === 'prism') {
        z.spin += dt * 1.8;
        z.tick -= dt;
        if (z.tick <= 0) {
          z.tick = z.int;
          const shots = z.core ? 2 : 1;
          let prev: Enemy | null = null;
          for (let k = 0; k < shots; k++) {
            // favour the real threats — bosses first, then whatever's nearest
            const t2 = this.nearestEnemy(z.x, z.y, z.maxR, prev, true);
            if (!t2) break;
            const a = Math.atan2(t2.y - z.y, t2.x - z.x);
            const d = Math.hypot(t2.x - z.x, t2.y - z.y);
            this.spawnRay(z.x, z.y, a, d + 30, z.dmg, 9);
            // a bright refraction bursts where the ray lands, so its work on a
            // boss (or anything) is unmistakable
            this.particles.spawn({ x: t2.x, y: t2.y, life: 0.28, size: 26, color: '#f4c9ff', mode: 'ring' });
            for (let m = 0; m < 9; m++) {
              const ra = rand(0, TAU);
              this.particles.spawn({ x: t2.x, y: t2.y, vx: Math.cos(ra) * rand(60, 190), vy: Math.sin(ra) * rand(60, 190), life: rand(0.2, 0.5), size: rand(2, 4.5), endSize: 0.5, color: pick(['#f4c9ff', '#9fffe0', '#ffffff']), mode: 'star', rotV: rand(-8, 8), drag: 0.86 });
            }
            audio.prismRay(this.panOf(z.x));
            // The Unblinking Prism: the ray refracts through its first victim
            if (z.evolved) {
              this.spawnRay(t2.x, t2.y, a + 0.5, 170, z.dmg * 0.5, 6);
              this.spawnRay(t2.x, t2.y, a - 0.5, 170, z.dmg * 0.5, 6);
            }
            prev = t2;
          }
        }
        // caustic sparkle drifting beneath the crystal
        if (Math.random() < 0.4) {
          const a = rand(0, TAU);
          this.particles.spawn({ x: z.x + Math.cos(a) * rand(6, 26), y: z.y + rand(16, 40), vx: rand(-10, 10), vy: rand(-8, 8), life: rand(0.4, 0.9), size: rand(1.5, 3), color: pick(['#f4c9ff', '#9fffe0', '#fff']), mode: 'glow', drag: 0.96 });
        }
      }

      if (z.life <= 0) {
        this.freeZone(z);
        swapRemove(this.zones, i);
        continue;
      }
      i++;
    }
  }
}
