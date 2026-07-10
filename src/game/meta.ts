// Meta progression: the Constellation — a persistent skill tree bought with
// stardust earned each run. Stored in localStorage (same key as the original
// game, so existing progress carries over when served from the same origin).

import { SPELLS, EVOLVE } from './spells';
import { settings } from './settings';

const STORE_KEY = 'dreamtide_meta_v3';

const deg = (d: number) => (d * Math.PI) / 180;

export interface TreeNode {
  id: string;
  x: number;
  y: number;
  cost: number;
  name: string;
  desc: string;
  fx: Record<string, any>;
  kind: 'core' | 'small' | 'notable' | 'keystone';
  requires: string[];
  currency?: 'shards';
}

export type TreeEdge = [string, string, number?];

export interface Meta {
  dust: number;
  shards: number;
  owned: string[];
  best: number;
  loadout: string[]; // spells carried into every run; length grows with slots
  // The Constellation stays hidden until its first-discovery reveal has
  // played (after the player's first death). Existing saves that clearly
  // interacted with the tree already are treated as revealed.
  treeRevealed: boolean;
}

// spells always available in the loadout regardless of unlocks
export const LOADOUT_BASE = 'arcane';
export const MAX_LOADOUT = 4;

// how many loadout slots the player has: 1 by default, +1 per spell-slot notable,
// capped at MAX_LOADOUT.
export function loadoutSlots(meta: Meta): number {
  let slots = 1;
  for (const id of meta.owned) {
    const n = NODE_MAP[id];
    if (n && n.fx.spellSlots) slots += n.fx.spellSlots as number;
  }
  return Math.min(MAX_LOADOUT, slots);
}

// spells the player may place in the loadout: Arcane (always) + any unlocked via
// a cluster's unlock notable.
export function unlockedSpells(meta: Meta): string[] {
  const set = new Set<string>([LOADOUT_BASE]);
  for (const id of meta.owned) {
    const n = NODE_MAP[id];
    if (n && n.fx.unlock && n.fx.spell) set.add(n.fx.spell as string);
  }
  return [...set];
}

// clamp a stored loadout to the current slot count & unlocks, always keeping at
// least Arcane in the first slot. Returns a fresh array.
export function sanitizeLoadout(meta: Meta): string[] {
  const slots = loadoutSlots(meta);
  const allowed = new Set(unlockedSpells(meta));
  const out: string[] = [];
  for (const id of meta.loadout || []) {
    if (out.length >= slots) break;
    if (allowed.has(id) && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) out.push(LOADOUT_BASE);
  return out;
}

export interface SpellMod {
  dmg: number; cd: number; aoe: number; dur: number; count: number;
  weight: number; evo: number; startLv: number; special: Record<string, number>;
}

export interface Bonuses {
  dmg: number; cast: number; aoe: number; speed: number; magnet: number; xp: number;
  dust: number; crit: number; critDmg: number; hp: number; regen: number;
  extraCount: number; echo: number; masteryPlus: number; startLv: number; fourfold: number;
  cheatDeath: number; deathBurst: number; banish: number; reroll: number;
  extraGem: number; gemMerge: number; golden: number; surgeDur: number; spellSlots: number;
  baneHp?: number; baneRate?: number; baneAhead?: number; baneDmg?: number;
  baneFloor?: number; baneSpeed?: number; baneElite?: number; baneBoss?: number;
  surge: Record<string, number>;
  startSpells: string[];
  loadout: string[]; // sanitized loadout spells the run should start with
  spellMods: Record<string, SpellMod>;
  [k: string]: any;
}

// ---------------------------------------------------------------- builders
const nodes: TreeNode[] = [];
const edges: TreeEdge[] = []; // [idA, idB, bend?] — bend curves the drawn edge
const add = (n: TreeNode) => { nodes.push(n); return n.id; };
const link = (a: string, b: string, bend?: number) => { edges.push(bend ? [a, b, bend] : [a, b]); };

add({ id: 'core', x: 0, y: 0, cost: 0, name: 'The Waking Eye', desc: 'Where every dream begins.', fx: {}, kind: 'core', requires: [] });

// ================================================================ main web
const PATH_RADII = [48, 84, 120, 156, 192, 228, 264, 300, 336, 372, 408, 444, 480];
const PATH_COSTS = [25, 40, 60, 100, 150, 210, 290, 390, 510, 660, 840, 1050, 1300];
const TWIG_AT = [2, 5, 9];
const TWIG_COSTS = [200, 550, 1100];
const NOTABLE_AT = [3, 7, 11];

interface ArmStep { n: string; d: string; fx: Record<string, number> }
interface Arm { angle: number; path: ArmStep[]; twigs: ArmStep[]; branch: ArmStep; end: ArmStep }

const ARMS: Record<string, Arm> = {
  might: {
    angle: -112.5,
    path: [
      { n: 'Ember Thought', d: '+4% spell damage', fx: { dmg: 4 } },
      { n: 'Ember Thought', d: '+4% spell damage', fx: { dmg: 4 } },
      { n: 'Cruel Glint', d: '+3% critical chance', fx: { crit: 3 } },
      { n: 'Kindled Will', d: '+10% spell damage', fx: { dmg: 10 } },
      { n: 'Sharpened Dream', d: '+5% spell damage', fx: { dmg: 5 } },
      { n: 'Cruel Glint', d: '+4% critical chance', fx: { crit: 4 } },
      { n: 'Sharpened Dream', d: '+5% spell damage', fx: { dmg: 5 } },
      { n: 'Red Portent', d: '+6% crit chance, crits deal +15% more', fx: { crit: 6, critDmg: 15 } },
      { n: 'Deep Focus', d: '+6% spell damage', fx: { dmg: 6 } },
      { n: 'Cruel Glint', d: '+4% critical chance', fx: { crit: 4 } },
      { n: 'Deep Focus', d: '+6% spell damage', fx: { dmg: 6 } },
      { n: 'Crimson Clarity', d: '+8% damage, +4% crit chance', fx: { dmg: 8, crit: 4 } },
      { n: 'Warlike Reverie', d: '+7% spell damage', fx: { dmg: 7 } },
    ],
    twigs: [
      { n: 'Stray Spark', d: '+5% spell damage', fx: { dmg: 5 } },
      { n: 'Wicked Edge', d: 'Crits deal +10% more', fx: { critDmg: 10 } },
      { n: 'Butcher’s Dream', d: 'Crits deal +20% more', fx: { critDmg: 20 } },
    ],
    branch: { n: 'Bloodmoon', d: '+10% crit chance, crits deal +50% more', fx: { crit: 10, critDmg: 50 } },
    end: { n: 'Overmind', d: 'Multi-shot spells fire +1 projectile', fx: { extraCount: 1 } },
  },
  tempo: {
    angle: -67.5,
    path: [
      { n: 'Quick Breath', d: '+3% spell haste', fx: { cast: 3 } },
      { n: 'Quick Breath', d: '+3% spell haste', fx: { cast: 3 } },
      { n: 'Feather Step', d: '+3% move speed', fx: { speed: 3 } },
      { n: 'Racing Pulse', d: '+8% spell haste', fx: { cast: 8 } },
      { n: 'Quick Breath', d: '+4% spell haste', fx: { cast: 4 } },
      { n: 'Feather Step', d: '+4% move speed', fx: { speed: 4 } },
      { n: 'Quick Breath', d: '+4% spell haste', fx: { cast: 4 } },
      { n: 'Slipstream', d: '+6% move speed, +4% spell haste', fx: { speed: 6, cast: 4 } },
      { n: 'Tidal Rhythm', d: '+5% spell haste', fx: { cast: 5 } },
      { n: 'Feather Step', d: '+4% move speed', fx: { speed: 4 } },
      { n: 'Tidal Rhythm', d: '+5% spell haste', fx: { cast: 5 } },
      { n: 'Heartbeat of the Deep', d: '+9% spell haste', fx: { cast: 9 } },
      { n: 'Restless Sleep', d: '+5% spell haste', fx: { cast: 5 } },
    ],
    twigs: [
      { n: 'Light Feet', d: '+4% move speed', fx: { speed: 4 } },
      { n: 'Hummingbird Thought', d: '+5% spell haste', fx: { cast: 5 } },
      { n: 'Gale Stride', d: '+6% move speed', fx: { speed: 6 } },
    ],
    branch: { n: 'Timeweaver', d: '+15% spell haste', fx: { cast: 15 } },
    end: { n: 'Echoing Thought', d: '10% chance to cast every spell twice', fx: { echo: 10 } },
  },
  cosmos: {
    angle: -22.5,
    path: [
      { n: 'Wider Dream', d: '+4% area of effect', fx: { aoe: 4 } },
      { n: 'Wider Dream', d: '+4% area of effect', fx: { aoe: 4 } },
      { n: 'Starlight', d: '+3% spell damage', fx: { dmg: 3 } },
      { n: 'Spreading Mist', d: '+10% area of effect', fx: { aoe: 10 } },
      { n: 'Stellar Reach', d: '+5% area of effect', fx: { aoe: 5 } },
      { n: 'Starlight', d: '+4% spell damage', fx: { dmg: 4 } },
      { n: 'Stellar Reach', d: '+5% area of effect', fx: { aoe: 5 } },
      { n: 'Event Horizon', d: '+8% area, +5% damage', fx: { aoe: 8, dmg: 5 } },
      { n: 'Vast Slumber', d: '+6% area of effect', fx: { aoe: 6 } },
      { n: 'Starlight', d: '+5% spell damage', fx: { dmg: 5 } },
      { n: 'Vast Slumber', d: '+6% area of effect', fx: { aoe: 6 } },
      { n: 'Nebular Heart', d: '+12% area of effect', fx: { aoe: 12 } },
      { n: 'Endless Sky', d: '+7% area of effect', fx: { aoe: 7 } },
    ],
    twigs: [
      { n: 'Drifting Veil', d: '+5% area of effect', fx: { aoe: 5 } },
      { n: 'Distant Light', d: '+6% spell damage', fx: { dmg: 6 } },
      { n: 'Horizon Line', d: '+8% area of effect', fx: { aoe: 8 } },
    ],
    branch: { n: 'Unbound Firmament', d: '+1 spell slot — hold one more spell at once', fx: { spellSlots: 1 } },
    end: { n: 'Cosmic Attunement', d: 'Mastery ranks grant +12% damage instead of +8%', fx: { masteryPlus: 4 } },
  },
  tides: {
    angle: 22.5,
    path: [
      { n: 'First Ripple', d: 'Every 8s: 10% chance of a 4s swiftness surge', fx: { surgeSpeed: 10 } },
      { n: 'Undertow', d: 'Every 8s: 8% chance of a 4s power surge', fx: { surgeDmg: 8 } },
      { n: 'Quickwater', d: 'Every 8s: 8% chance of a 4s haste surge', fx: { surgeHaste: 8 } },
      { n: 'The Tide Turns', d: 'You may reroll one set of level-up choices each dream', fx: { reroll: 1 } },
      { n: 'Swelling Dream', d: 'Every 8s: 10% chance of a 4s area surge', fx: { surgeAoe: 10 } },
      { n: 'Moonpull', d: 'Every 8s: 12% chance of a 4s pickup surge', fx: { surgeMagnet: 12 } },
      { n: 'Second Ripple', d: '+10% swiftness surge chance', fx: { surgeSpeed: 10 } },
      { n: 'Stormfront', d: '+15% power surge chance', fx: { surgeDmg: 15 } },
      { n: 'Quickwater', d: '+10% haste surge chance', fx: { surgeHaste: 10 } },
      { n: 'Swelling Dream', d: '+10% area surge chance', fx: { surgeAoe: 10 } },
      { n: 'Moonpull', d: '+12% pickup surge chance', fx: { surgeMagnet: 12 } },
      { n: 'Spring Tide', d: '+15% swiftness and +10% power surge chance', fx: { surgeSpeed: 15, surgeDmg: 10 } },
      { n: 'Third Ripple', d: '+12% haste surge chance', fx: { surgeHaste: 12 } },
    ],
    twigs: [
      { n: 'Shell Song', d: '+10% pickup surge chance', fx: { surgeMagnet: 10 } },
      { n: 'Deep Current', d: '+8% power surge chance', fx: { surgeDmg: 8 } },
      { n: 'Wide Wake', d: '+12% area surge chance', fx: { surgeAoe: 12 } },
    ],
    branch: { n: 'Dreamsurge', d: '+10% chance to every kind of surge', fx: { surgeAll: 10 } },
    end: { n: 'Perpetual Tide', d: 'Surges last 3 seconds longer', fx: { surgeDur: 3 } },
  },
  gleaning: {
    angle: 67.5,
    path: [
      { n: 'Gleaner', d: '+4% essence gained', fx: { xp: 4 } },
      { n: 'Spare Dreams', d: 'Slain foes: 3% chance to drop a bonus orb', fx: { extraGem: 3 } },
      { n: 'Soft Pull', d: '+12% pickup radius', fx: { magnet: 12 } },
      { n: 'Confluence', d: 'Essence orbs that drift together merge into one brighter orb', fx: { gemMerge: 1 } },
      { n: 'Spare Dreams', d: '+4% bonus orb chance', fx: { extraGem: 4 } },
      { n: 'Gleaner', d: '+5% essence gained', fx: { xp: 5 } },
      { n: 'Spare Dreams', d: '+4% bonus orb chance', fx: { extraGem: 4 } },
      { n: 'Bountiful Sleep', d: '+8% bonus orb chance', fx: { extraGem: 8 } },
      { n: 'Soft Pull', d: '+16% pickup radius', fx: { magnet: 16 } },
      { n: 'Spare Dreams', d: '+5% bonus orb chance', fx: { extraGem: 5 } },
      { n: 'Gleaner', d: '+6% essence gained', fx: { xp: 6 } },
      { n: 'Harvest of Sighs', d: '+10% bonus orb chance, +8% essence gained', fx: { extraGem: 10, xp: 8 } },
      { n: 'Soft Pull', d: '+20% pickup radius', fx: { magnet: 20 } },
    ],
    twigs: [
      { n: 'Keen Eye', d: '+6% essence gained', fx: { xp: 6 } },
      { n: 'Scattered Sleep', d: '+5% bonus orb chance', fx: { extraGem: 5 } },
      { n: 'Tithe of Night', d: '+6% bonus orb chance', fx: { extraGem: 6 } },
    ],
    branch: { n: 'Boundless Reverie', d: '+1 spell slot — hold one more spell at once', fx: { spellSlots: 1 } },
    end: { n: 'Golden Dream', d: 'Golden wisps visit twice as often', fx: { golden: 1 } },
  },
  fortune: {
    angle: 112.5,
    path: [
      { n: 'Dream Lure', d: '+16% pickup radius', fx: { magnet: 16 } },
      { n: 'Gleaner', d: '+5% essence gained', fx: { xp: 5 } },
      { n: 'Soft Pull', d: '+12% pickup radius', fx: { magnet: 12 } },
      { n: 'Wide Lure', d: '+30% pickup radius', fx: { magnet: 30 } },
      { n: 'Gleaner', d: '+6% essence gained', fx: { xp: 6 } },
      { n: 'Keen Eye', d: '+6% essence gained', fx: { xp: 6 } },
      { n: 'Dream Lure', d: '+20% pickup radius', fx: { magnet: 20 } },
      { n: 'Lucky Star', d: '+10% essence gained, +12% pickup radius', fx: { xp: 10, magnet: 12 } },
      { n: 'Dream Lure', d: '+20% pickup radius', fx: { magnet: 20 } },
      { n: 'Gleaner', d: '+6% essence gained', fx: { xp: 6 } },
      { n: 'Gleaner', d: '+8% essence gained', fx: { xp: 8 } },
      { n: 'Sea of Offerings', d: '+36% pickup radius, +6% essence', fx: { magnet: 36, xp: 6 } },
      { n: 'Dream Lure', d: '+20% pickup radius', fx: { magnet: 20 } },
    ],
    twigs: [
      { n: 'Gentle Gravity', d: '+20% pickup radius', fx: { magnet: 20 } },
      { n: 'Keen Eye', d: '+8% essence gained', fx: { xp: 8 } },
      { n: 'Falling Star', d: '+8% essence gained, +10% pickup radius', fx: { xp: 8, magnet: 10 } },
    ],
    branch: { n: 'Comet’s Purse', d: '+30% pickup radius, +8% essence gained', fx: { magnet: 30, xp: 8 } },
    end: { n: 'Waking Start', d: 'Begin every dream with your spells one level stronger', fx: { startLv: 1 } },
  },
  vital: {
    angle: 157.5,
    path: [
      { n: 'Warm Blood', d: '+10 max life', fx: { hp: 10 } },
      { n: 'Warm Blood', d: '+10 max life', fx: { hp: 10 } },
      { n: 'Slow Mending', d: 'Mend 1 life every 2s', fx: { regen: 1 } },
      { n: 'Heartroot', d: '+25 max life', fx: { hp: 25 } },
      { n: 'Warm Blood', d: '+12 max life', fx: { hp: 12 } },
      { n: 'Slow Mending', d: 'Mend 1 life every 2s', fx: { regen: 1 } },
      { n: 'Deep Roots', d: '+15 max life', fx: { hp: 15 } },
      { n: 'Evergreen Sleep', d: '+20 max life · mend 1 more life every 2s', fx: { hp: 20, regen: 1 } },
      { n: 'Deep Roots', d: '+15 max life', fx: { hp: 15 } },
      { n: 'Slow Mending', d: 'Mend 1 life every 2s', fx: { regen: 1 } },
      { n: 'Deep Roots', d: '+18 max life', fx: { hp: 18 } },
      { n: 'Heart of the Dream', d: '+35 max life', fx: { hp: 35 } },
      { n: 'Old Growth', d: '+20 max life', fx: { hp: 20 } },
    ],
    twigs: [
      { n: 'Thick Skin', d: '+12 max life', fx: { hp: 12 } },
      { n: 'Dewdrop', d: 'Mend 1 life every 2s', fx: { regen: 1 } },
      { n: 'Heartwood', d: '+25 max life', fx: { hp: 25 } },
    ],
    branch: { n: 'Moonmilk Vein', d: '+15 max life · mend 2 more life every 2s', fx: { regen: 2, hp: 15 } },
    end: { n: 'Second Wind', d: 'Once per dream, survive death with half your life', fx: { cheatDeath: 1 } },
  },
  fate: {
    angle: -157.5,
    path: [
      { n: 'Clear Sight', d: '+3% damage, +2% spell haste', fx: { dmg: 3, cast: 2 } },
      { n: 'Dream Logic', d: '+4% essence gained', fx: { xp: 4 } },
      { n: 'Clear Sight', d: '+3% area, +2% damage', fx: { aoe: 3, dmg: 2 } },
      { n: 'The Refused Dream', d: 'You may banish one level-up offer each dream', fx: { banish: 1 } },
      { n: 'Woven Fate', d: '+3% spell haste, +3% area', fx: { cast: 3, aoe: 3 } },
      { n: 'Clear Sight', d: '+4% spell damage', fx: { dmg: 4 } },
      { n: 'Dream Logic', d: '+8% essence gained', fx: { xp: 8 } },
      { n: 'The Second Refusal', d: 'You may banish one more offer each dream', fx: { banish: 1 } },
      { n: 'Woven Fate', d: '+4% damage, +3% spell haste', fx: { dmg: 4, cast: 3 } },
      { n: 'Dream Logic', d: '+5% essence gained', fx: { xp: 5 } },
      { n: 'Woven Fate', d: '+4% area, +3% spell haste', fx: { aoe: 4, cast: 3 } },
      { n: 'Loom of Nights', d: 'You may reroll one more set of choices each dream', fx: { reroll: 1 } },
      { n: 'Threads Converge', d: '+5% damage, +4% area', fx: { dmg: 5, aoe: 4 } },
    ],
    twigs: [
      { n: 'Small Mercy', d: '+6% essence gained', fx: { xp: 6 } },
      { n: 'The Third Refusal', d: 'You may banish one more offer each dream', fx: { banish: 1 } },
      { n: 'Turning Page', d: 'You may reroll one more set of choices each dream', fx: { reroll: 1 } },
    ],
    branch: { n: 'Widening Loom', d: '+1 spell slot — hold one more spell at once', fx: { spellSlots: 1 } },
    end: { n: 'Fourfold Path', d: 'Level-ups offer a fourth choice', fx: { fourfold: 1 } },
  },
};

const SWEEP = 3.6; // degrees of angular drift per path step
const armAngle = (arm: Arm, i: number) => deg(arm.angle + SWEEP * i);

const linkOut = (idA: string, idB: string, k: number) => {
  const A = nodes.find((n) => n.id === idA)!, B = nodes.find((n) => n.id === idB)!;
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy) || 1;
  const s = (mx * (-dy / L) + my * (dx / L)) >= 0 ? 1 : -1;
  link(idA, idB, s * k);
};

for (const [key, arm] of Object.entries(ARMS)) {
  let prev = 'core';
  arm.path.forEach((def, i) => {
    const a = armAngle(arm, i);
    const r = PATH_RADII[i];
    const id = add({
      id: `${key}${i}`, x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r),
      cost: PATH_COSTS[i], name: def.n, desc: def.d, fx: def.fx,
      kind: NOTABLE_AT.includes(i) ? 'notable' : 'small', requires: [prev],
    });
    link(prev, id, -6);
    prev = id;
  });
  TWIG_AT.forEach((at, t) => {
    const pa = armAngle(arm, at);
    const side = t % 2 ? 1 : -1;
    const px = Math.round(Math.cos(pa) * PATH_RADII[at] + Math.cos(pa + Math.PI / 2) * side * 56 + Math.cos(pa) * 12);
    const py = Math.round(Math.sin(pa) * PATH_RADII[at] + Math.sin(pa + Math.PI / 2) * side * 56 + Math.sin(pa) * 12);
    add({
      id: `${key}T${t}`, x: px, y: py,
      cost: TWIG_COSTS[t], name: arm.twigs[t].n, desc: arm.twigs[t].d, fx: arm.twigs[t].fx,
      kind: arm.twigs[t].fx.banish || arm.twigs[t].fx.reroll ? 'notable' : 'small',
      requires: [`${key}${at}`],
    });
    link(`${key}${at}`, `${key}T${t}`, side * 10);
  });
  const ka = armAngle(arm, 13.2);
  add({
    id: `${key}K`, x: Math.round(Math.cos(ka) * 528), y: Math.round(Math.sin(ka) * 528),
    cost: 5500, name: arm.end.n, desc: arm.end.d, fx: arm.end.fx,
    kind: 'keystone', requires: [`${key}12`],
  });
  link(`${key}12`, `${key}K`, -7);
  const ba = armAngle(arm, 8) + deg(22);
  const br = (PATH_RADII[8] + PATH_RADII[11]) / 2;
  add({
    id: `${key}B`, x: Math.round(Math.cos(ba) * br), y: Math.round(Math.sin(ba) * br),
    cost: 3000, name: arm.branch.n, desc: arm.branch.d, fx: arm.branch.fx,
    kind: 'keystone', requires: [`${key}8`],
  });
  linkOut(`${key}8`, `${key}B`, 14);
}

// connector rings
const ARM_KEYS_SORTED = Object.keys(ARMS).sort((x, y) => ARMS[x].angle - ARMS[y].angle);
const RING_FX = [
  { d: '+3% spell damage', fx: { dmg: 3 } },
  { d: '+2% spell haste', fx: { cast: 2 } },
  { d: '+3% area of effect', fx: { aoe: 3 } },
  { d: '+8 max life', fx: { hp: 8 } },
  { d: '+12% pickup radius', fx: { magnet: 12 } },
  { d: '+4% essence gained', fx: { xp: 4 } },
  { d: '+3% move speed', fx: { speed: 3 } },
  { d: '+2% critical chance', fx: { crit: 2 } },
];
[{ idx: 2, cost: 100 }, { idx: 5, cost: 350 }, { idx: 8, cost: 800 }, { idx: 11, cost: 1500 }].forEach((ring, ri) => {
  ARM_KEYS_SORTED.forEach((key, k) => {
    const nextKey = ARM_KEYS_SORTED[(k + 1) % ARM_KEYS_SORTED.length];
    let a1 = ARMS[key].angle, a2 = ARMS[nextKey].angle;
    while (a2 < a1) a2 += 360;
    const mid = deg((a1 + a2) / 2 + SWEEP * ring.idx);
    const r = PATH_RADII[ring.idx];
    const f = RING_FX[(k + ri * 3) % RING_FX.length];
    const id = add({
      id: `g${ring.idx}-${key}`, x: Math.round(Math.cos(mid) * r), y: Math.round(Math.sin(mid) * r),
      cost: ring.cost, name: 'Faint Star', desc: f.d, fx: f.fx,
      kind: 'small', requires: [`${key}${ring.idx}`, `${nextKey}${ring.idx}`],
    });
    linkOut(`${key}${ring.idx}`, id, 8 + r * 0.02);
    linkOut(id, `${nextKey}${ring.idx}`, 8 + r * 0.02);
  });
});

// catch-all: derive any remaining straight edges from requires
for (const n of nodes) for (const r of n.requires) link(r, n.id);

// ================================================================ clusters
const CLUSTER_DIST = 880;
const SMALL_COSTS = [225, 275, 325, 375, 425, 475, 525];
const AOE_SPELLS = ['ember', 'frost', 'void', 'petals', 'moon', 'starfall', 'nebula', 'sigil', 'lantern', 'nova'];
const DUR_SPELLS = ['frost', 'void', 'nebula', 'sigil', 'lantern'];

interface MediumDef { n: string; d: string; scount?: number; special?: Record<string, number> }

const MEDIUMS: Record<string, MediumDef[]> = {
  arcane: [
    { n: 'Splinter Point', d: 'Missiles pierce one additional foe.', special: { pierce: 1 } },
    { n: 'Hungry Seekers', d: 'Missiles fly 20% faster and turn harder.', special: { seek: 20 } },
  ],
  ember: [
    { n: 'Twin Cinders', d: '+1 ember.', scount: 1 },
    { n: 'Tight Carpet', d: 'Embers fall in a tighter, overlapping carpet.', special: { carpet: 1 } },
  ],
  frost: [
    { n: 'Creeping Cold', d: 'Even bosses feel the bloom’s chill, at half strength.', special: { bossChill: 1 } },
    { n: 'Brittle Dreams', d: 'Slowed foes take 15% more damage from everything.', special: { chillAmp: 15 } },
  ],
  storm: [
    { n: 'Longer Ladder', d: 'Lightning leaps one more time.', scount: 1 },
    { n: 'Persistent Charge', d: 'Chains fade far less with each leap.', special: { falloff: 1 } },
  ],
  void: [
    { n: 'Deeper Hunger', d: 'Rifts pull 50% harder.', special: { pull: 50 } },
    { n: 'Inevitable Gravity', d: 'Even bosses are dragged toward the rift.', special: { bossPull: 1 } },
  ],
  petals: [
    { n: 'Mirror Waltz', d: 'Petals bat enemy shots back the way they came (10% chance).', special: { reflect: 10 } },
    { n: 'Heavy Bloom', d: 'Petal knockback is doubled.', special: { knock2: 1 } },
  ],
  moon: [
    { n: 'Broader Light', d: 'Lances are 30% wider.', special: { wide: 30 } },
    { n: 'Long Reflection', d: 'Lances reach 50% farther.', special: { reach: 50 } },
  ],
  starfall: [
    { n: 'Meteoric Mass', d: 'Star impacts briefly stun what they strike.', special: { stun: 1 } },
    { n: 'Deeper Firmament', d: '+1 falling star.', scount: 1 },
  ],
  umbra: [
    { n: 'Winter Fangs', d: 'Fangs chill everything they cut.', special: { chill: 1 } },
    { n: 'Maw of Night', d: 'Fangs are 40% larger.', special: { big: 40 } },
  ],
  glaive: [
    { n: 'Far Orbit', d: 'Glaives fly 30% farther before returning.', special: { range: 30 } },
    { n: 'Razor Cycle', d: 'Glaives can strike the same foe far more often.', special: { fastHit: 1 } },
  ],
  nebula: [
    { n: 'Whispering Mist', d: 'The cloud slows foes wandering inside it.', special: { slowIn: 25 } },
    { n: 'Newborn Heart', d: 'The cloud’s dense heart deals double damage.', special: { core: 1 } },
  ],
  sigil: [
    { n: 'Quick Inscription', d: 'Sigils arm 35% sooner.', special: { armFast: 1 } },
    { n: 'Deeper Sleep', d: 'The rune’s sleep lasts 1s longer.', special: { sleep: 1 } },
  ],
  lantern: [
    { n: 'Long Vigil', d: 'Lanterns burn 1.2 seconds longer.', special: { vigil: 1.2 } },
    { n: 'Kindly Lights', d: 'Expiring lanterns sometimes leave a healing spark.', special: { heal: 12 } },
  ],
  nova: [
    { n: 'Riptide Dusk', d: 'Nova knockback +60%.', special: { knock: 60 } },
    { n: 'Dissolving Dusk', d: 'The wave unmakes enemy shots it washes over (10% chance).', special: { dissolve: 10 } },
  ],
};

interface Shape { pts: [number, number][]; edges: [number, number, number?][]; roles: { entry: number; evo: number; start: number; med: [number, number] } }

const SHAPES: Record<string, Shape> = {
  arcane: {
    pts: [[0, 115], [0, 72], [0, 35], [30, 5], [80, -25], [30, -55], [0, -115], [-30, -55], [-80, -25], [-30, 5], [0, -25], [0, -70]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 2], [10, 3], [10, 5], [10, 7], [10, 9], [10, 11], [11, 6]],
    roles: { entry: 0, evo: 10, start: 6, med: [8, 4] },
  },
  ember: {
    pts: [[0, 115], [48, 85], [78, 38], [64, -18], [34, -62], [10, -108], [-20, -70], [-48, -28], [-72, 22], [-46, 82], [0, 28], [0, -30]],
    edges: [[0, 1, 8], [1, 2, 10], [2, 3, 10], [3, 4, -10], [4, 5, -12], [5, 6, -12], [6, 7, 10], [7, 8, 10], [8, 9, 12], [9, 0, 12], [0, 10], [10, 11], [11, 5]],
    roles: { entry: 0, evo: 10, start: 5, med: [7, 3] },
  },
  frost: {
    pts: [[0, 112], [0, 52], [-45, 26], [-45, -26], [0, -52], [45, -26], [45, 26], [-98, -56], [0, -114], [98, -56], [-92, 54], [92, 54]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 1], [3, 7], [4, 8], [5, 9], [2, 10], [6, 11]],
    roles: { entry: 0, evo: 8, start: 4, med: [7, 9] },
  },
  storm: {
    pts: [[40, 115], [2, 88], [30, 58], [-6, 32], [24, 2], [-12, -24], [20, -48], [-16, -72], [14, -92], [-22, -114], [-48, 64], [58, -82]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [1, 10], [8, 11]],
    roles: { entry: 0, evo: 11, start: 9, med: [3, 6] },
  },
  void: {
    pts: [[0, 108], [-83, 54], [-83, -37], [-13, -81], [55, -50], [63, 17], [17, 53], [-30, 37], [-39, -4], [-14, -28], [11, -19], [0, 2]],
    edges: [[0, 1, 16], [1, 2, 16], [2, 3, 14], [3, 4, 14], [4, 5, 12], [5, 6, 12], [6, 7, 10], [7, 8, 10], [8, 9, 8], [9, 10, 6], [10, 11, 4]],
    roles: { entry: 0, evo: 11, start: 9, med: [4, 8] },
  },
  moon: {
    pts: [[52, 91], [-18, 103], [-80, 67], [-105, 0], [-80, -67], [-18, -103], [52, -91], [65, -61], [96, -24], [96, 24], [65, 61], [30, 0]],
    edges: [[0, 1, 12], [1, 2, 12], [2, 3, 12], [3, 4, 12], [4, 5, 12], [5, 6, 12], [6, 7], [7, 8, -8], [8, 9, -8], [9, 10, -8], [10, 0, -8], [8, 11], [9, 11]],
    roles: { entry: 0, evo: 3, start: 6, med: [2, 9] },
  },
  starfall: {
    pts: [[108, -108], [80, -80], [52, -52], [26, -24], [2, 4], [-40, 12], [-2, 40], [-17, 84], [-63, 84], [-78, 40], [-40, 52], [95, -62]],
    edges: [[0, 1, 6], [1, 2, 6], [2, 3, 6], [3, 4, 6], [4, 5, 6], [5, 6], [6, 7], [7, 8], [8, 9], [9, 5], [10, 5], [10, 7], [10, 9], [1, 11]],
    roles: { entry: 0, evo: 10, start: 8, med: [9, 6] },
  },
  umbra: {
    pts: [[70, 110], [20, 95], [-30, 70], [-65, 30], [-85, -20], [-90, -75], [-80, -115], [-55, -60], [-35, -5], [-5, 45], [35, 80], [52, 92]],
    edges: [[0, 1, 10], [1, 2, 10], [2, 3, 10], [3, 4, 10], [4, 5, 8], [5, 6, 6], [6, 7, -8], [7, 8, -10], [8, 9, -10], [9, 10, -10], [10, 11], [11, 0]],
    roles: { entry: 0, evo: 6, start: 10, med: [3, 8] },
  },
  glaive: {
    pts: [[0, 110], [0, 70], [-38, 48], [-70, 12], [-92, -32], [-100, -80], [38, 48], [70, 12], [92, -32], [100, -80], [0, 20], [0, -35]],
    edges: [[0, 1], [1, 2, 8], [2, 3, 8], [3, 4, 8], [4, 5, 8], [1, 6, -8], [6, 7, -8], [7, 8, -8], [8, 9, -8], [1, 10], [10, 11]],
    roles: { entry: 0, evo: 9, start: 5, med: [3, 7] },
  },
  nebula: {
    pts: [[0, 78], [-62, 61], [-100, 24], [-100, -24], [-62, -61], [0, -78], [62, -61], [100, -24], [100, 24], [62, 61], [0, 0], [0, -38]],
    edges: [[0, 1, 14], [1, 2, 14], [2, 3, 14], [3, 4, 14], [4, 5, 14], [5, 6, 14], [6, 7, 14], [7, 8, 14], [8, 9, 14], [9, 0, 14], [10, 0], [10, 11], [11, 5]],
    roles: { entry: 0, evo: 10, start: 5, med: [3, 7] },
  },
  sigil: {
    pts: [[0, 105], [-74, 74], [-105, 0], [-74, -74], [0, -105], [74, -74], [105, 0], [74, 74], [0, -55], [48, 27], [-48, 27], [0, 0]],
    edges: [[0, 1, 16], [1, 2, 16], [2, 3, 16], [3, 4, 16], [4, 5, 16], [5, 6, 16], [6, 7, 16], [7, 0, 16], [8, 9], [9, 10], [10, 8], [11, 8], [11, 9], [11, 10], [4, 8]],
    roles: { entry: 0, evo: 11, start: 4, med: [10, 9] },
  },
  lantern: {
    pts: [[0, 118], [-85, 15], [85, 15], [-45, 45], [45, 45], [-45, -15], [45, -15], [0, 10], [0, -50], [0, -82], [25, -110], [0, 80]],
    edges: [[0, 11], [11, 3], [3, 5], [5, 8], [8, 6], [6, 4], [4, 11], [5, 1], [6, 2], [8, 9], [9, 10, -10], [7, 11], [7, 8]],
    roles: { entry: 0, evo: 7, start: 9, med: [1, 2] },
  },
  petals: {
    pts: [[0, 118], [0, 25], [0, -55], [76, 0], [47, 90], [-47, 90], [-76, 0], [-26, -11], [26, -11], [43, 39], [0, 70], [-43, 39]],
    edges: [[0, 10], [1, 7], [1, 8], [1, 9], [1, 10], [1, 11], [7, 2, -8], [2, 8, 8], [8, 3, -8], [3, 9, 8], [9, 4, -8], [4, 10, 8], [10, 5, -8], [5, 11, 8], [11, 6, -8], [6, 7, 8]],
    roles: { entry: 0, evo: 1, start: 2, med: [6, 3] },
  },
  nova: {
    pts: [[0, 105], [74, 74], [105, 0], [74, -74], [0, -105], [-74, -74], [-105, 0], [-74, 74], [0, 48], [42, -24], [-42, -24], [0, 0]],
    edges: [[0, 1, 14], [1, 2, 14], [2, 3, 14], [3, 4, 14], [4, 5, 14], [5, 6, 14], [6, 7, 14], [7, 0, 14], [8, 9, -8], [9, 10, -8], [10, 8, -8], [11, 8], [11, 9], [11, 10], [0, 8]],
    roles: { entry: 0, evo: 11, start: 4, med: [10, 9] },
  },
};

const CLUSTER_ORDER = ['arcane', 'ember', 'frost', 'storm', 'void', 'moon', 'starfall', 'umbra', 'glaive', 'nebula', 'sigil', 'lantern', 'petals', 'nova'];

export interface ClusterInfo { spell: string; name: string; color: string; cx: number; cy: number; ids: string[] }
export const CLUSTER_INFO: ClusterInfo[] = [];

const RING_SLOTS = CLUSTER_ORDER.length + 1;

CLUSTER_ORDER.forEach((spellId, k) => {
  const s = SPELLS[spellId];
  const spec = SHAPES[spellId];
  const meds = MEDIUMS[spellId];
  const ca = deg(((k + 1) / RING_SLOTS) * 360 + 90);
  const cx = Math.round(Math.cos(ca) * CLUSTER_DIST);
  const cy = Math.round(Math.sin(ca) * CLUSTER_DIST);
  const ids: string[] = [];
  const hasAoe = AOE_SPELLS.includes(spellId);
  const hasDur = DUR_SPELLS.includes(spellId);
  const smallTpl = [
    { d: `+8% ${s.name} damage`, fx: { sdmg: 8 } },
    { d: `+6% ${s.name} haste`, fx: { scd: 6 } },
    hasAoe ? { d: `+8% ${s.name} area`, fx: { saoe: 8 } } : { d: `+8% ${s.name} damage`, fx: { sdmg: 8 } },
    { d: `+8% ${s.name} damage`, fx: { sdmg: 8 } },
    hasDur ? { d: `+12% ${s.name} duration`, fx: { sdur: 12 } } : (hasAoe ? { d: `+8% ${s.name} area`, fx: { saoe: 8 } } : { d: `+6% ${s.name} haste`, fx: { scd: 6 } }),
    { d: `+6% ${s.name} haste`, fx: { scd: 6 } },
    { d: `+10% ${s.name} damage`, fx: { sdmg: 10 } },
  ];
  let smallIdx = 0;
  spec.pts.forEach((pt, i) => {
    let def: Omit<TreeNode, 'id' | 'x' | 'y'>;
    if (i === spec.roles.entry) {
      def = { cost: 250, kind: 'small', name: `Dream of ${s.name}`, desc: `${s.name} appears far more often among your level-up choices.`, fx: { spell: spellId, weight: 1 }, requires: [] };
    } else if (i === spec.roles.evo) {
      def = { cost: 2000, kind: 'keystone', name: EVOLVE[spellId].name, desc: `Unlock ${s.name}'s evolution — ${EVOLVE[spellId].desc}`, fx: { spell: spellId, evo: 1 }, requires: [] };
    } else if (i === spec.roles.start) {
      // Arcane is already the default loadout spell, so its "start" node gives a
      // level head-start instead. Every other cluster's node unlocks that spell
      // for the loadout (chosen in the loadout UI under the tree).
      def = spellId === LOADOUT_BASE
        ? { cost: 1000, kind: 'notable', name: `Waking ${s.icon}`, desc: `Begin every dream with ${s.name} one level stronger.`, fx: { spell: spellId, startLv: 1 }, requires: [] }
        : { cost: 1000, kind: 'notable', name: `Dream-Etched ${s.icon}`, desc: `Unlock ${s.name} for your loadout — carry it into every dream.`, fx: { spell: spellId, unlock: 1 }, requires: [] };
    } else if (spec.roles.med.includes(i)) {
      const m = meds[spec.roles.med.indexOf(i)];
      const fx: Record<string, any> = { spell: spellId };
      if (m.scount) fx.scount = m.scount;
      if (m.special) fx.special = m.special;
      def = { cost: 800, kind: 'notable', name: m.n, desc: m.d, fx, requires: [] };
    } else {
      const t = smallTpl[smallIdx % smallTpl.length];
      def = { cost: SMALL_COSTS[smallIdx % SMALL_COSTS.length], kind: 'small', name: `Mote of ${s.name}`, desc: t.d, fx: { spell: spellId, ...t.fx }, requires: [] };
      smallIdx++;
    }
    const id = `${spellId}-${i}`;
    add({ id, x: cx + pt[0], y: cy + pt[1], ...def });
    ids.push(id);
  });
  for (const [i, j, bend] of spec.edges) {
    link(`${spellId}-${i}`, `${spellId}-${j}`, bend);
    const ni = nodes.find((n) => n.id === `${spellId}-${i}`)!;
    const nj = nodes.find((n) => n.id === `${spellId}-${j}`)!;
    if (i !== spec.roles.entry) ni.requires.push(`${spellId}-${j}`);
    if (j !== spec.roles.entry) nj.requires.push(`${spellId}-${i}`);
  }
  CLUSTER_INFO.push({ spell: spellId, name: s.name, color: s.color, cx, cy, ids });
});

// ====================================================== the dark bargain
const DARK_CX = 0, DARK_CY = CLUSTER_DIST;
const DARK_NODES: { p: [number, number]; kind: TreeNode['kind']; cost: number; n: string; d: string; fx: Record<string, number>; entry?: boolean }[] = [
  { p: [0, -112], kind: 'small', cost: 2, n: 'The Dark Bargain', d: '+12% stardust earned · enemies have +20% life', fx: { dust: 12, baneHp: 20 }, entry: true },
  { p: [28, -28], kind: 'small', cost: 2, n: 'Restless Horde', d: '+12% stardust earned · the tide spawns 20% faster', fx: { dust: 12, baneRate: 20 } },
  { p: [112, 0], kind: 'notable', cost: 5, n: 'Cruel Dawn', d: '+18% stardust earned · the dream begins 120 seconds deeper', fx: { dust: 18, baneAhead: 120 } },
  { p: [28, 28], kind: 'small', cost: 2, n: 'Sharpened Nightmares', d: '+12% stardust earned · enemies strike 20% harder', fx: { dust: 12, baneDmg: 20 } },
  { p: [0, 112], kind: 'notable', cost: 5, n: 'Deep Tide', d: '+18% stardust earned · at least 12 more enemies swarm you at all times', fx: { dust: 18, baneFloor: 12 } },
  { p: [-28, 28], kind: 'small', cost: 2, n: 'Fleet Shadows', d: '+12% stardust earned · enemies move 15% faster', fx: { dust: 12, baneSpeed: 15 } },
  { p: [-112, 0], kind: 'notable', cost: 5, n: 'Hungry Dark', d: '+18% stardust earned · elites stir 50% more often', fx: { dust: 18, baneElite: 50 } },
  { p: [-28, -28], kind: 'small', cost: 2, n: 'Iron Dreams', d: '+12% stardust earned · enemies have +22% life', fx: { dust: 12, baneHp: 22 } },
  { p: [0, 0], kind: 'keystone', cost: 12, n: 'The Black Star', d: '+45% stardust earned · enemies have +30% life and strike 25% harder', fx: { dust: 45, baneHp: 30, baneDmg: 25 } },
  { p: [0, -64], kind: 'small', cost: 2, n: 'Toll of Night', d: '+12% stardust earned · at least 8 more enemies swarm you at all times', fx: { dust: 12, baneFloor: 8 } },
  { p: [64, 0], kind: 'notable', cost: 5, n: 'Devourer’s Haste', d: '+18% stardust earned · the Devourer comes 40% sooner', fx: { dust: 18, baneBoss: 40 } },
  { p: [-64, 0], kind: 'small', cost: 2, n: 'Thin Veil', d: '+12% stardust earned · the tide spawns 18% faster', fx: { dust: 12, baneRate: 18 } },
];
const DARK_EDGES: [number, number, number?][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0], [0, 9], [9, 8], [8, 10], [10, 2], [8, 11], [11, 6], [4, 8]];
{
  const ids: string[] = [];
  DARK_NODES.forEach((def, i) => {
    const id = `dark-${i}`;
    add({ id, x: DARK_CX + def.p[0], y: DARK_CY + def.p[1], cost: def.cost, currency: 'shards', name: def.n, desc: def.d, fx: def.fx, kind: def.kind, requires: [] });
    ids.push(id);
  });
  const lookup = (id: string) => nodes.find((n) => n.id === id)!;
  for (const [i, j, bend] of DARK_EDGES) {
    link(`dark-${i}`, `dark-${j}`, bend);
    if (i !== 0) lookup(`dark-${i}`).requires.push(`dark-${j}`);
    if (j !== 0) lookup(`dark-${j}`).requires.push(`dark-${i}`);
  }
  CLUSTER_INFO.push({ spell: 'dark', name: 'The Dark Bargain', color: '#ff5a7a', cx: DARK_CX, cy: DARK_CY, ids });
}

export const TREE_NODES = nodes;
export const NODE_MAP: Record<string, TreeNode> = Object.fromEntries(nodes.map((n) => [n.id, n]));
export const TREE_EDGES: TreeEdge[] = (() => {
  const seen = new Set<string>();
  const out: TreeEdge[] = [];
  for (const e of edges) {
    const key = e[0] < e[1] ? e[0] + '|' + e[1] : e[1] + '|' + e[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
})();

// ---------------------------------------------------------------- storage
export function loadMeta(): Meta {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const meta: Meta = {
        dust: d.dust || 0, shards: d.shards || 0,
        owned: Array.isArray(d.owned) ? d.owned.filter((id: string) => NODE_MAP[id]) : ['core'],
        best: d.best || 0,
        loadout: Array.isArray(d.loadout) ? d.loadout : [LOADOUT_BASE],
        // migration: only saves from BEFORE this field existed fall back to
        // the heuristic (they've plainly used the tree if they own stars or
        // hold dust). Saves that carry the field keep it verbatim — a new
        // player who dies and reloads before touching the glimmer must NOT
        // be auto-marked as having seen the reveal.
        treeRevealed: d.treeRevealed !== undefined
          ? !!d.treeRevealed
          : (Array.isArray(d.owned) && d.owned.length > 1) || (d.dust || 0) > 0 || (d.best || 0) > 0,
      };
      meta.loadout = sanitizeLoadout(meta);
      return meta;
    }
  } catch { /* corrupted store — start fresh */ }
  return { dust: 0, shards: 0, owned: ['core'], best: 0, loadout: [LOADOUT_BASE], treeRevealed: false };
}

export function saveMeta(meta: Meta) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(meta)); } catch { /* private mode */ }
}

// undirected adjacency: owning either endpoint of an edge opens the other
export const ADJACENT: Record<string, string[]> = (() => {
  const adj: Record<string, string[]> = {};
  for (const [a, b] of TREE_EDGES) {
    (adj[a] = adj[a] || []).push(b);
    (adj[b] = adj[b] || []).push(a);
  }
  return adj;
})();

export function isReachable(meta: Meta, id: string): boolean {
  const n = NODE_MAP[id];
  if (!n) return false;
  if (n.requires.length === 0) return true; // core & cluster entries
  return (ADJACENT[id] || []).some((r) => meta.owned.includes(r));
}

export function nodeCurrency(id: string): 'dust' | 'shards' {
  const n = NODE_MAP[id];
  return (n && n.currency) || 'dust';
}

export function canBuy(meta: Meta, id: string): boolean {
  const n = NODE_MAP[id];
  if (!n || meta.owned.includes(id)) return false;
  // dev: unlimited currency — only reachability gates the purchase
  if (!settings.devFreeTree && (meta[nodeCurrency(id)] || 0) < n.cost) return false;
  return isReachable(meta, id);
}

export function buyNode(meta: Meta, id: string): Meta {
  if (!canBuy(meta, id)) return meta;
  const cur = nodeCurrency(id);
  const cost = settings.devFreeTree ? 0 : NODE_MAP[id].cost;
  const next = { ...meta, [cur]: (meta[cur] || 0) - cost, owned: [...meta.owned, id] };
  next.loadout = sanitizeLoadout(next); // slot/unlock changes may affect it
  saveMeta(next);
  return next;
}

// the first-discovery reveal has played — the Constellation is now a plain menu
export function markTreeRevealed(meta: Meta): Meta {
  if (meta.treeRevealed) return meta;
  const next = { ...meta, treeRevealed: true };
  saveMeta(next);
  return next;
}

// set the loadout (from the loadout UI), clamped to current slots & unlocks.
export function setLoadout(meta: Meta, loadout: string[]): Meta {
  const next = { ...meta, loadout };
  next.loadout = sanitizeLoadout(next);
  saveMeta(next);
  return next;
}

export function refundValue(id: string): number {
  const n = NODE_MAP[id];
  if (!n) return 0;
  return n.currency === 'shards' ? n.cost : Math.floor(n.cost / 2);
}

export function canRefund(meta: Meta, id: string): boolean {
  const n = NODE_MAP[id];
  if (!n || id === 'core' || !meta.owned.includes(id)) return false;
  const owned = new Set(meta.owned);
  owned.delete(id);
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const o of owned) {
    if (NODE_MAP[o] && NODE_MAP[o].requires.length === 0) { seen.add(o); stack.push(o); }
  }
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nb of ADJACENT[cur] || []) {
      if (owned.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return seen.size === owned.size;
}

export function refundNode(meta: Meta, id: string): Meta {
  if (!canRefund(meta, id)) return meta;
  const cur = nodeCurrency(id);
  const next = { ...meta, [cur]: (meta[cur] || 0) + refundValue(id), owned: meta.owned.filter((o) => o !== id) };
  next.loadout = sanitizeLoadout(next); // refunding a slot/unlock may shrink it
  saveMeta(next);
  return next;
}

// fold owned nodes into one bonus object for the engine
export function computeBonuses(meta: Meta): Bonuses {
  const b: Bonuses = {
    dmg: 0, cast: 0, aoe: 0, speed: 0, magnet: 0, xp: 0, dust: 0, crit: 0, critDmg: 0,
    hp: 0, regen: 0, extraCount: 0, echo: 0, masteryPlus: 0, startLv: 0, fourfold: 0,
    cheatDeath: 0, deathBurst: 0, banish: 0, reroll: 0, extraGem: 0, gemMerge: 0,
    golden: 0, surgeDur: 0, spellSlots: 0,
    surge: { speed: 0, dmg: 0, haste: 0, aoe: 0, magnet: 0 },
    startSpells: [], loadout: sanitizeLoadout(meta), spellMods: {},
  };
  const modFor = (spell: string): SpellMod => (b.spellMods[spell] = b.spellMods[spell] || { dmg: 0, cd: 0, aoe: 0, dur: 0, count: 0, weight: 0, evo: 0, startLv: 0, special: {} });
  for (const id of meta.owned) {
    const n = NODE_MAP[id];
    if (!n) continue;
    if (n.fx.spell) {
      const m = modFor(n.fx.spell);
      for (const [k, v] of Object.entries(n.fx)) {
        if (k === 'spell') continue;
        if (k === 'sdmg') m.dmg += v as number;
        else if (k === 'scd') m.cd += v as number;
        else if (k === 'saoe') m.aoe += v as number;
        else if (k === 'sdur') m.dur += v as number;
        else if (k === 'scount') m.count += v as number;
        else if (k === 'weight') m.weight += v as number;
        else if (k === 'evo') m.evo = 1;
        else if (k === 'startLv') m.startLv += v as number;
        else if (k === 'unlock') { /* loadout unlock — handled by unlockedSpells */ }
        else if (k === 'special') for (const [sk, sv] of Object.entries(v as Record<string, number>)) m.special[sk] = (m.special[sk] || 0) + sv;
      }
      continue;
    }
    for (const [k, v] of Object.entries(n.fx)) {
      if (k === 'surgeAll') { for (const t of Object.keys(b.surge)) b.surge[t] += v as number; }
      else if (k.startsWith('surge') && k !== 'surgeDur') {
        const t = k.slice(5).toLowerCase();
        b.surge[t] = (b.surge[t] || 0) + (v as number);
      } else {
        b[k] = (b[k] || 0) + (v as number);
      }
    }
  }
  return b;
}

export interface RunResult { time: number; kills: number; level: number; bonusDust?: number; shards?: number }

export function dustForRun(result: RunResult, bonuses: Partial<Bonuses>): number {
  const base = result.kills * 0.35 + result.level * 3 + result.time / 6;
  return Math.max(1, Math.round(base * (1 + (bonuses.dust || 0) / 100)) + (result.bonusDust || 0));
}
