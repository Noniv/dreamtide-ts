// Data-oriented plumbing for the simulation: entity structs, object pools,
// stamp-based hit masks, and the spatial grid. Everything here is built so a
// steady-state frame allocates zero bytes: entities are pooled and reused,
// hit-tracking uses rented typed arrays instead of per-cast Sets, and the grid
// reuses its bucket arrays across frames.

export const TAU = Math.PI * 2;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T,>(arr: T[]): T => arr[(Math.random() * arr.length) | 0];
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const dist2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;

// hard ceiling on concurrently-alive enemies; the spawner caps at 420 + bosses
// + event bursts, so 704 slots never exhaust. Slots index the hit masks.
export const ENEMY_SLOTS = 704;

// ---------------------------------------------------------------- entities
export interface RangedProfile { range: number; cd: number; projSpeed: number; shots: number }

export interface BossFire {
  cd: number; interval: number; speed: number;
  spin: number; spinV: number; patterns: string[]; pIdx: number;
  // >0 roots the boss in place (the Colossus plants itself to slam, so its
  // slow rings stay centred on the body that threw them)
  hold: number;
  // blink choreography (the Shade): blinkT counts down the wind-up while the
  // body folds into a seam of night; bx/by is the exit, chosen up front and
  // marked so the vanishing act is a promise, not a cheat; blinkIn counts
  // down the unfold at the far end (the greeting fan fires when it hits 0)
  blinkT: number; blinkDur: number; blinkIn: number; bx: number; by: number;
  // ring-gap choreography (Colossus slams, ring volleys): the safe gap first
  // opens toward the player, then walks a fixed step around the circle each
  // volley in gapDir's direction — an escape pattern to learn, not a dice
  // roll that can land unreachably behind the boss. null = not aimed yet.
  gapAng: number | null; gapDir: number;
}

export interface Enemy {
  uid: number;          // unique forever (pierce tracking)
  slot: number;         // index into hit masks, recycled after death
  type: string;
  boss: boolean;
  elite: boolean;
  golden: boolean;
  dead: boolean;
  x: number; y: number;
  px: number; py: number; // previous sim position (render interpolation)
  hp: number; maxHp: number;
  speed: number; dmg: number; radius: number; xp: number;
  color: string;
  slow: number; slowT: number;
  // hard-CC saturation for elites/golden/ranged: repeated pull/freeze/sleep/knock
  // fills ccSat; at 1 it flips to a brief immunity window (ccImmT) and the meter
  // resets, so the endgame CC-blanket can't perma-lock the real threats.
  ccSat: number; ccImmT: number;
  // seconds this boss has been alive-and-onscreen; drives enrage (fire rate ramp)
  rageT: number;
  // Resonance marks: storm hits leave a charge that discharges on death,
  // light hits leave a brand that amplifies damage and fuels Eclipse.
  // reactCd is an absolute sim-time stamp gating reactions per enemy.
  chargeT: number; chargeDmg: number; brandT: number; reactCd: number;
  // Nightmare Brand: a red name written on the strong. Ticks nbDps (+nbPct of
  // max life) while nbT runs, bursts nbBurst on death, spreads if nbSpread.
  nbT: number; nbDps: number; nbPct: number; nbTick: number; nbAmp: number;
  nbSpread: boolean; nbBurst: number;
  hitFlash: number; animT: number; seed: number;
  knbx: number; knby: number;
  goldT: number;
  shootCd: number;       // ranged: <0 means uninitialised
  dmgTextT: number;
  meleeCd: number;       // time until this enemy can melee again
  meleeBaseCd: number;   // per-type attack cooldown (spawn-order tuned)
  meleeReach: number;    // extra reach beyond collision for the melee strike
  meleeAnim: number;     // >0 while the strike lunge/flash plays out
  ranged: RangedProfile | null;
  bossFire: BossFire | null;
}

export type ProjKind = 'arcane' | 'ember' | 'comet' | 'fang' | 'glaive';

export interface Projectile {
  kind: ProjKind;
  dead: boolean;
  x: number; y: number; px: number; py: number;
  vx: number; vy: number;
  speed: number; dmg: number; life: number; r: number;
  // arcane
  turn: number; target: Enemy | null; splinter: boolean; pierce: number;
  // uid of `target` when it was picked: pooled Enemy objects are recycled for
  // fresh spawns (dead flips back to false), so the reference alone can't
  // prove the target is still the same creature.
  targetUid: number;
  struckA: number; struckB: number; // uids already pierced (-1 = none)
  // ember / comet
  sx: number; sy: number; tx: number; ty: number;
  t: number; dur: number; arc: number;
  x0: number; y0: number; hasX0: boolean;
  stun: boolean;
  burnDps: number; burnC1: string; burnC2: string; hasBurn: boolean;
  // fang
  hit: HitMask | null; chill: boolean;
  // glaive
  a: number; travelled: number; range: number; returning: boolean;
  spin: number; hitCd: HitTimer | null; hitInt: number; evolved: boolean;
}

export interface BossProjectile {
  dead: boolean;
  x: number; y: number; px: number; py: number;
  vx: number; vy: number;
  life: number; r: number; dmg: number;
  color: string | null;
  // Mirror Waltz: batted back by a petal — now hunts the horde instead
  reflected: boolean;
  // absolute sim-time gate so one petal contact rolls the reflect chance once
  parryT: number;
}

export type ZoneKind =
  | 'frostwave' | 'rift' | 'nebula' | 'sigil' | 'scorch' | 'novawave' | 'lantern'
  | 'serpent' | 'chimewave' | 'prism';

export interface Zone {
  kind: ZoneKind;
  dead: boolean;
  x: number; y: number; px: number; py: number;
  r: number; pr: number; maxR: number;
  life: number; maxLife: number; delay: number;
  dmg: number; dps: number;
  slow: number; slowDur: number; sleepDur: number;
  pull: number; knock: number;
  tick: number; int: number;
  spin: number; seed: number; ph: number;
  dvx: number; dvy: number;
  evolved: boolean; boomed: boolean; echo: boolean; echoed: boolean;
  bossChill: boolean; bossPull: boolean; slowIn: number; core: boolean;
  // dissolve: % chance the wavefront unmakes enemy shots it crosses (0 = off)
  dissolve: number; heal: number;
  c1: string; c2: string;
  hit: HitMask | null;
  // serpent: second timer (steering cadence), growth multiplier (Leviathan),
  // and its current steering target (ox/oy)
  tick2: number; grow: number; ox: number; oy: number;
}

export interface Beam {
  dead: boolean;
  x: number; y: number; a: number; pa: number;
  len: number; w: number;
  life: number; maxLife: number;
  dmg: number; sweep: number;
  hit: HitMask | null;
  // lance = Moonlance flash · gaze = Sleepless Eye's rotating watch (origin
  // follows the player, re-hits on hitT) · ray = a Kaleidoscope refraction
  kind: 'lance' | 'gaze' | 'ray';
  hitT: HitTimer | null; int: number;
  stun: boolean; follow: boolean;
  linger: boolean; // Aurora Crown: the gaze leaves fading light behind
}

export interface Bolt {
  dead: boolean;
  ptsX: Float32Array; ptsY: Float32Array; n: number;
  life: number; maxLife: number;
}

export interface Gem {
  dead: boolean;
  x: number; y: number; px: number; py: number;
  v: number; big: boolean; heal: boolean; shard: boolean; merged: boolean;
  ph: number;
}

export interface FloatText {
  dead: boolean;
  x: number; y: number;
  str: string; color: string;
  life: number; vy: number; size: number;
}

export interface Pickup {
  dead: boolean;
  x: number; y: number;
  life: number; ph: number;
  kind: 'heal' | 'gems' | 'dust' | 'altar';
}

export interface Orbital {
  a: number; dir: number; radF: number;
  x: number; y: number; px: number; py: number;
  hitCd: HitTimer;
}

// ---------------------------------------------------------------- factories
export function makeEnemy(): Enemy {
  return {
    uid: 0, slot: 0, type: 'wisp', boss: false, elite: false, golden: false, dead: false,
    x: 0, y: 0, px: 0, py: 0, hp: 1, maxHp: 1, speed: 0, dmg: 0, radius: 10, xp: 1,
    color: '#fff', slow: 0, slowT: 0, ccSat: 0, ccImmT: 0, rageT: 0,
    chargeT: 0, chargeDmg: 0, brandT: 0, reactCd: 0,
    nbT: 0, nbDps: 0, nbPct: 0, nbTick: 0, nbAmp: 0, nbSpread: false, nbBurst: 0,
    hitFlash: 0, animT: 0, seed: 0,
    knbx: 0, knby: 0, goldT: 0, shootCd: -1, dmgTextT: 0,
    meleeCd: 0, meleeBaseCd: 1, meleeReach: 6, meleeAnim: 0, ranged: null, bossFire: null,
  };
}

export function makeProjectile(): Projectile {
  return {
    kind: 'arcane', dead: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
    speed: 0, dmg: 0, life: 0, r: 5,
    turn: 0, target: null, targetUid: 0, splinter: false, pierce: 0, struckA: -1, struckB: -1,
    sx: 0, sy: 0, tx: 0, ty: 0, t: 0, dur: 1, arc: 0,
    x0: 0, y0: 0, hasX0: false, stun: false,
    burnDps: 0, burnC1: '', burnC2: '', hasBurn: false,
    hit: null, chill: false,
    a: 0, travelled: 0, range: 0, returning: false, spin: 0,
    hitCd: null, hitInt: 0.45, evolved: false,
  };
}

export function makeBossProjectile(): BossProjectile {
  return { dead: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, life: 0, r: 6, dmg: 0, color: null, reflected: false, parryT: 0 };
}

export function makeZone(): Zone {
  return {
    kind: 'frostwave', dead: false, x: 0, y: 0, px: 0, py: 0, r: 0, pr: 0, maxR: 0,
    life: 0, maxLife: 1, delay: 0, dmg: 0, dps: 0, slow: 0, slowDur: 0, sleepDur: 0,
    pull: 0, knock: 0, tick: 0, int: 0.8, spin: 0, seed: 0, ph: 0, dvx: 0, dvy: 0,
    evolved: false, boomed: false, echo: false, echoed: false,
    bossChill: false, bossPull: false, slowIn: 0, core: false, dissolve: 0, heal: 0,
    c1: '', c2: '', hit: null,
    tick2: 0, grow: 1, ox: 0, oy: 0,
  };
}

export function makeBeam(): Beam {
  return {
    dead: false, x: 0, y: 0, a: 0, pa: 0, len: 0, w: 0, life: 0, maxLife: 1, dmg: 0, sweep: 0, hit: null,
    kind: 'lance', hitT: null, int: 0.4, stun: false, follow: false, linger: false,
  };
}

export function makeBolt(): Bolt {
  return { dead: false, ptsX: new Float32Array(14), ptsY: new Float32Array(14), n: 0, life: 0, maxLife: 0.22 };
}

export function makeGem(): Gem {
  return { dead: false, x: 0, y: 0, px: 0, py: 0, v: 1, big: false, heal: false, shard: false, merged: false, ph: 0 };
}

export function makeText(): FloatText {
  return { dead: false, x: 0, y: 0, str: '', color: '#fff', life: 0, vy: 0, size: 13 };
}

// ---------------------------------------------------------------- pool
// A dead-simple free-list pool. acquire() hands back a reset-by-caller object;
// dense arrays of live entities are compacted with swapRemove.
export class Pool<T> {
  private free: T[] = [];
  constructor(private factory: () => T, prealloc = 0) {
    for (let i = 0; i < prealloc; i++) this.free.push(factory());
  }
  acquire(): T { return this.free.pop() || this.factory(); }
  release(o: T) { this.free.push(o); }
}

// swap-remove arr[i]; returns the removed item. Caller must NOT advance i.
export function swapRemove<T>(arr: T[], i: number): T {
  const o = arr[i];
  const last = arr.length - 1;
  arr[i] = arr[last];
  arr.pop();
  return o;
}

// ---------------------------------------------------------------- hit masks
// Stamp-based per-effect hit tracking. Each renter gets a globally-unique
// stamp, so rented arrays never need clearing: a slot is "marked" only if it
// holds *this* renter's stamp. Replaces the per-cast `new Set()`s.
let stampCounter = 1;

export class HitMask {
  arr = new Uint32Array(ENEMY_SLOTS);
  stamp = 0;
  begin() { this.stamp = ++stampCounter; return this; }
  has(slot: number) { return this.arr[slot] === this.stamp; }
  mark(slot: number) { this.arr[slot] = this.stamp; }
}

// per-slot cooldown timers (glaive re-hit, petal ticks)
export class HitTimer {
  stampArr = new Uint32Array(ENEMY_SLOTS);
  tArr = new Float32Array(ENEMY_SLOTS);
  stamp = 0;
  begin() { this.stamp = ++stampCounter; return this; }
  ready(slot: number, now: number) { return this.stampArr[slot] !== this.stamp || this.tArr[slot] <= now; }
  set(slot: number, next: number) { this.stampArr[slot] = this.stamp; this.tArr[slot] = next; }
}

export const maskPool = new Pool<HitMask>(() => new HitMask(), 8);
export const timerPool = new Pool<HitTimer>(() => new HitTimer(), 4);

// ---------------------------------------------------------------- grid
// A coarse uniform grid over the enemies, rebuilt once per sim step. It turns
// every "scan enemies within radius R" query into O(enemies in nearby cells).
const GRID_CELL = 130;

export class SpatialGrid {
  cells = new Map<number, Enemy[]>();
  cell = GRID_CELL;
  private pool: Enemy[][] = [];
  private poolN = 0;

  private key(cx: number, cy: number) { return cx * 100000 + cy; }

  rebuild(items: Enemy[]) {
    this.cells.clear();
    this.poolN = 0;
    const c = this.cell;
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      if (e.dead) continue;
      const k = this.key(Math.floor(e.x / c), Math.floor(e.y / c));
      let bucket = this.cells.get(k);
      if (!bucket) {
        bucket = this.pool[this.poolN];
        if (bucket) bucket.length = 0; else { bucket = []; this.pool[this.poolN] = bucket; }
        this.poolN++;
        this.cells.set(k, bucket);
      }
      bucket.push(e);
    }
  }

  queryCircle(x: number, y: number, r: number, fn: (e: Enemy) => void) {
    const c = this.cell;
    const minX = Math.floor((x - r) / c), maxX = Math.floor((x + r) / c);
    const minY = Math.floor((y - r) / c), maxY = Math.floor((y + r) / c);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (!e.dead) fn(e);
        }
      }
    }
  }
}
