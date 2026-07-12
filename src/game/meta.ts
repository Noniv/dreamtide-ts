// Meta progression: the Constellation — a persistent, Path-of-Exile-style web
// of ~800 stars. Every star costs exactly one skill point; skill points are
// forged at the tree's heart for stardust at an ever-rising price. Planning
// means routing: a star can only be awakened next to one you already own.
//
// The Dark Bargain is a second, far smaller web fed with nightmare shards.
// Its stars start every dream deeper — harder, but the clock (and your best
// time) starts deeper too.
//
// Stored in localStorage under v4; v3 saves migrate with a full refund.

import { SPELLS, EVOLVE } from './spells';
import { settings } from './settings';
import { LEGACY_COSTS } from './legacyCosts';

const STORE_KEY = 'dreamtide_meta_v4';
const LEGACY_KEY = 'dreamtide_meta_v3';

const deg = (d: number) => (d * Math.PI) / 180;

export type NodeKind = 'core' | 'small' | 'notable' | 'keystone';

export interface TreeNode {
  id: string;
  x: number;
  y: number;
  name: string;
  desc: string;
  fx: Record<string, any>;
  kind: NodeKind;
  dark?: boolean; // belongs to the Dark Bargain web
}

export type TreeEdge = [string, string]; // always drawn as a straight line

export interface Meta {
  dust: number;
  shards: number;
  // constellation skill points: unspent pool + lifetime total (sets the price
  // of the next one — 20, 30, 40, … stardust, no cap)
  points: number;
  pointsBought: number;
  // dark bargain points: 1, 2, 3, … shards
  darkPoints: number;
  darkPointsBought: number;
  owned: string[];     // allocated constellation stars (always contains 'core')
  darkOwned: string[]; // allocated bargain stars (always contains 'dark-core')
  best: number;
  loadout: string[];
  treeRevealed: boolean; // the first-discovery reveal has played
  darkRevealed: boolean;
}

// spells always available in the loadout regardless of unlocks
export const LOADOUT_BASE = 'arcane';
export const MAX_LOADOUT = 4;

export function loadoutSlots(meta: Meta): number {
  let slots = 1;
  for (const id of meta.owned) {
    const n = NODE_MAP[id];
    if (n && n.fx.spellSlots) slots += n.fx.spellSlots as number;
  }
  return Math.min(MAX_LOADOUT, slots);
}

export function unlockedSpells(meta: Meta): string[] {
  const set = new Set<string>([LOADOUT_BASE]);
  for (const id of meta.owned) {
    const n = NODE_MAP[id];
    if (n && n.fx.unlock && n.fx.spell) set.add(n.fx.spell as string);
  }
  return [...set];
}

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
  loadout: string[];
  spellMods: Record<string, SpellMod>;
  [k: string]: any;
}

// ================================================================ builders
const nodes: TreeNode[] = [];
const edges: TreeEdge[] = [];
const byId: Record<string, TreeNode> = {};
const add = (n: TreeNode) => { nodes.push(n); byId[n.id] = n; return n.id; };
// Every connection is a straight line — curved edges pointed in inconsistent
// directions and muddied the web's read. The optional third tuple slot in the
// shape data (a legacy bend) is deliberately ignored.
const link = (a: string, b: string, _bend?: number) => { edges.push([a, b]); };
const linkArc = (idA: string, idB: string, _k?: number) => { link(idA, idB); };

interface Stat { n: string; d: string; fx: Record<string, any> }
const S = (n: string, d: string, fx: Record<string, any>): Stat => ({ n, d, fx });

// ================================================================ themes
// Eight schools of the dream, one per 45° sector, mirroring the old arms.
interface ClusterDef { name: string; smalls: Stat[]; notable: Stat }
interface Theme {
  key: string; label: string;
  travel: Stat[];      // spoke smalls, cycled outward
  notables: [Stat, Stat]; // spoke notables at steps 3 and 7
  clusters: ClusterDef[];
  keystone: Stat;
}

const THEMES: Theme[] = [
  {
    key: 'might', label: 'Fury',
    travel: [
      S('Ember Thought', '+4% spell damage', { dmg: 4 }),
      S('Cruel Glint', '+2% critical chance', { crit: 2 }),
      S('Sharpened Dream', '+5% spell damage', { dmg: 5 }),
      S('Wicked Edge', '+8% critical damage', { critDmg: 8 }),
    ],
    notables: [
      S('Kindled Will', '+15% spell damage', { dmg: 15 }),
      S('Red Portent', '+6% crit chance, +15% critical damage', { crit: 6, critDmg: 15 }),
    ],
    clusters: [
      {
        name: 'Bloodmoon', notable: S('Bloodmoon', '+8% crit chance, +35% critical damage', { crit: 8, critDmg: 35 }),
        smalls: [S('Red Sliver', '+3% critical chance', { crit: 3 }), S('Moon Scar', '+10% critical damage', { critDmg: 10 }), S('Ember Thought', '+5% spell damage', { dmg: 5 })],
      },
      {
        name: 'Butcher’s Dream', notable: S('Butcher’s Dream', '+40% critical damage', { critDmg: 40 }),
        smalls: [S('Keen Fang', '+12% critical damage', { critDmg: 12 }), S('Cruel Glint', '+3% critical chance', { crit: 3 }), S('Sharpened Dream', '+5% spell damage', { dmg: 5 })],
      },
      {
        name: 'Warlike Reverie', notable: S('Warlike Reverie', '+23% spell damage', { dmg: 23 }),
        smalls: [S('Deep Focus', '+6% spell damage', { dmg: 6 }), S('Kindled Ember', '+6% spell damage', { dmg: 6 }), S('War Whisper', '+2% critical chance, +4% spell damage', { crit: 2, dmg: 4 })],
      },
    ],
    keystone: S('Overmind', 'Spells that fire several projectiles fire one more', { extraCount: 1 }),
  },
  {
    key: 'tempo', label: 'Haste',
    travel: [
      S('Quick Breath', '+4% cast speed', { cast: 4 }),
      S('Feather Step', '+2% move speed', { speed: 2 }),
      S('Restless Sleep', '+4% cast speed', { cast: 4 }),
      S('Light Feet', '+3% move speed', { speed: 3 }),
    ],
    notables: [
      S('Racing Pulse', '+13% cast speed', { cast: 13 }),
      S('Slipstream', '+6% move speed, +6% cast speed', { speed: 6, cast: 6 }),
    ],
    clusters: [
      {
        name: 'Timeweaver', notable: S('Timeweaver', '+19% cast speed', { cast: 19 }),
        smalls: [S('Loose Thread', '+5% cast speed', { cast: 5 }), S('Quick Stitch', '+5% cast speed', { cast: 5 }), S('Feather Step', '+3% move speed', { speed: 3 })],
      },
      {
        name: 'Gale Stride', notable: S('Gale Stride', '+10% move speed', { speed: 10 }),
        smalls: [S('Wind at Heel', '+4% move speed', { speed: 4 }), S('Light Feet', '+3% move speed', { speed: 3 }), S('Quick Breath', '+5% cast speed', { cast: 5 })],
      },
      {
        name: 'Heartbeat of the Deep', notable: S('Heartbeat of the Deep', '+15% cast speed, +4% move speed', { cast: 15, speed: 4 }),
        smalls: [S('Tidal Rhythm', '+5% cast speed', { cast: 5 }), S('Racing Thought', '+5% cast speed', { cast: 5 }), S('Restless Sleep', '+4% cast speed', { cast: 4 })],
      },
    ],
    keystone: S('Echoing Thought', '10% chance to cast every spell twice', { echo: 10 }),
  },
  {
    key: 'cosmos', label: 'Breadth',
    travel: [
      S('Wider Dream', '+4% area of effect', { aoe: 4 }),
      S('Starlight', '+4% spell damage', { dmg: 4 }),
      S('Stellar Reach', '+5% area of effect', { aoe: 5 }),
      S('Drifting Veil', '+4% area of effect', { aoe: 4 }),
    ],
    notables: [
      S('Spreading Mist', '+15% area of effect', { aoe: 15 }),
      S('Event Horizon', '+10% area of effect, +8% spell damage', { aoe: 10, dmg: 8 }),
    ],
    clusters: [
      {
        name: 'Nebular Heart', notable: S('Nebular Heart', '+20% area of effect', { aoe: 20 }),
        smalls: [S('Soft Nebula', '+6% area of effect', { aoe: 6 }), S('Vast Slumber', '+5% area of effect', { aoe: 5 }), S('Starlight', '+5% spell damage', { dmg: 5 })],
      },
      {
        name: 'Endless Sky', notable: S('Endless Sky', '+15% area of effect, +8% spell damage', { aoe: 15, dmg: 8 }),
        smalls: [S('Horizon Line', '+6% area of effect', { aoe: 6 }), S('Wider Dream', '+5% area of effect', { aoe: 5 }), S('Sky Ribbon', '+4% area of effect, +3% spell damage', { aoe: 4, dmg: 3 })],
      },
      {
        name: 'Vault of Stars', notable: S('Vault of Stars', '+13% area of effect, +10% spell damage', { aoe: 13, dmg: 10 }),
        smalls: [S('Star Seed', '+5% spell damage', { dmg: 5 }), S('Stellar Reach', '+5% area of effect', { aoe: 5 }), S('Vast Slumber', '+5% area of effect', { aoe: 5 })],
      },
    ],
    keystone: S('Cosmic Attunement', 'Mastery ranks grant +12% damage instead of +8%', { masteryPlus: 4 }),
  },
  {
    key: 'tides', label: 'Tides',
    travel: [
      S('First Ripple', '+5% swiftness surge chance', { surgeSpeed: 5 }),
      S('Undertow', '+5% power surge chance', { surgeDmg: 5 }),
      S('Quickwater', '+5% haste surge chance', { surgeHaste: 5 }),
      S('Swelling Dream', '+5% area surge chance', { surgeAoe: 5 }),
      S('Moonpull', '+6% pickup surge chance', { surgeMagnet: 6 }),
    ],
    notables: [
      S('Stormfront', '+15% power surge chance', { surgeDmg: 15 }),
      S('Spring Tide', '+12% swiftness and +8% power surge chance', { surgeSpeed: 12, surgeDmg: 8 }),
    ],
    clusters: [
      {
        name: 'Dreamsurge', notable: S('Dreamsurge', '+8% chance to trigger every kind of surge', { surgeAll: 8 }),
        smalls: [S('Rising Swell', '+6% power surge chance', { surgeDmg: 6 }), S('Second Ripple', '+6% swiftness surge chance', { surgeSpeed: 6 }), S('Quickwater', '+6% haste surge chance', { surgeHaste: 6 })],
      },
      {
        name: 'Deep Current', notable: S('Deep Current', '+18% power surge chance', { surgeDmg: 18 }),
        smalls: [S('Undertow', '+6% power surge chance', { surgeDmg: 6 }), S('Dark Water', '+6% power surge chance', { surgeDmg: 6 }), S('Cold Swell', '+5% area surge chance', { surgeAoe: 5 })],
      },
      {
        name: 'Wide Wake', notable: S('Wide Wake', '+15% area and +10% pickup surge chance', { surgeAoe: 15, surgeMagnet: 10 }),
        smalls: [S('Swelling Dream', '+6% area surge chance', { surgeAoe: 6 }), S('Moonpull', '+7% pickup surge chance', { surgeMagnet: 7 }), S('Foam Trail', '+5% swiftness surge chance', { surgeSpeed: 5 })],
      },
    ],
    keystone: S('Perpetual Tide', 'Surges last 3 seconds longer (4s → 7s)', { surgeDur: 3 }),
  },
  {
    key: 'gleaning', label: 'Harvest',
    travel: [
      S('Gleaner', '+3% essence gained', { xp: 3 }),
      S('Spare Dreams', '+3% bonus essence orb chance', { extraGem: 3 }),
      S('Keen Eye', '+3% essence gained', { xp: 3 }),
      S('Scattered Sleep', '+3% bonus essence orb chance', { extraGem: 3 }),
    ],
    notables: [
      S('Bountiful Sleep', '+10% bonus essence orb chance', { extraGem: 10 }),
      S('Harvest of Sighs', '+8% bonus essence orb chance, +6% essence gained', { extraGem: 8, xp: 6 }),
    ],
    clusters: [
      {
        name: 'Confluence', notable: S('Confluence', 'Essence orbs that drift together merge into one brighter orb', { gemMerge: 1 }),
        smalls: [S('Braided Light', '+4% essence gained', { xp: 4 }), S('Gleaner', '+4% essence gained', { xp: 4 }), S('Spare Dreams', '+4% bonus essence orb chance', { extraGem: 4 })],
      },
      {
        name: 'Tithe of Night', notable: S('Tithe of Night', '+12% bonus essence orb chance', { extraGem: 12 }),
        smalls: [S('Night Offering', '+4% bonus essence orb chance', { extraGem: 4 }), S('Scattered Sleep', '+4% bonus essence orb chance', { extraGem: 4 }), S('Keen Eye', '+4% essence gained', { xp: 4 })],
      },
      {
        name: 'Field of Sighs', notable: S('Field of Sighs', '+12% essence gained', { xp: 12 }),
        smalls: [S('Quiet Reaping', '+4% essence gained', { xp: 4 }), S('Gleaner', '+4% essence gained', { xp: 4 }), S('Dream Sheaf', '+3% essence gained, +3% bonus essence orb chance', { xp: 3, extraGem: 3 })],
      },
    ],
    keystone: S('Golden Dream', 'Golden wisps visit twice as often', { golden: 1 }),
  },
  {
    key: 'fortune', label: 'Fortune',
    travel: [
      S('Dream Lure', '+8% pickup radius', { magnet: 8 }),
      S('Falling Star', '+3% essence gained', { xp: 3 }),
      S('Soft Pull', '+8% pickup radius', { magnet: 8 }),
      S('Lodestone Heart', '+10% pickup radius', { magnet: 10 }),
    ],
    notables: [
      S('Wide Lure', '+25% pickup radius', { magnet: 25 }),
      S('Lucky Star', '+10% essence gained, +12% pickup radius', { xp: 10, magnet: 12 }),
    ],
    clusters: [
      {
        name: 'Comet’s Purse', notable: S('Comet’s Purse', '+30% pickup radius, +8% essence gained', { magnet: 30, xp: 8 }),
        smalls: [S('Stardust Trail', '+10% pickup radius', { magnet: 10 }), S('Dream Lure', '+8% pickup radius', { magnet: 8 }), S('Falling Star', '+4% essence gained', { xp: 4 })],
      },
      {
        name: 'Sea of Offerings', notable: S('Sea of Offerings', '+25% pickup radius, +6% essence gained', { magnet: 25, xp: 6 }),
        smalls: [S('Silver Net', '+10% pickup radius', { magnet: 10 }), S('Soft Pull', '+8% pickup radius', { magnet: 8 }), S('Keen Eye', '+4% essence gained', { xp: 4 })],
      },
      {
        name: 'Beggar’s Firmament', notable: S('Beggar’s Firmament', '+10% essence gained, +10% pickup radius', { xp: 10, magnet: 10 }),
        smalls: [S('Kind Orbit', '+8% pickup radius', { magnet: 8 }), S('Falling Star', '+4% essence gained', { xp: 4 }), S('Dream Lure', '+8% pickup radius', { magnet: 8 })],
      },
    ],
    keystone: S('Waking Start', 'Begin every dream with your spells one level stronger', { startLv: 1 }),
  },
  {
    key: 'vital', label: 'Roots',
    travel: [
      S('Warm Blood', '+8 max life', { hp: 8 }),
      S('Thick Skin', '+10 max life', { hp: 10 }),
      S('Deep Roots', '+8 max life', { hp: 8 }),
      S('Dewdrop', 'Regenerate 1 life every 4s', { regen: 0.5 }),
    ],
    notables: [
      S('Heartroot', '+30 max life', { hp: 30 }),
      S('Evergreen Sleep', '+20 max life · regenerate 1 more life every 2s', { hp: 20, regen: 1 }),
    ],
    clusters: [
      {
        name: 'Moonmilk Vein', notable: S('Moonmilk Vein', '+15 max life · regenerate 2 more life every 2s', { regen: 2, hp: 15 }),
        smalls: [S('Milk Drop', 'Regenerate 1 life every 4s', { regen: 0.5 }), S('Warm Blood', '+10 max life', { hp: 10 }), S('Dewdrop', 'Regenerate 1 life every 4s', { regen: 0.5 })],
      },
      {
        name: 'Heart of the Dream', notable: S('Heart of the Dream', '+40 max life', { hp: 40 }),
        smalls: [S('Heartwood', '+12 max life', { hp: 12 }), S('Deep Roots', '+10 max life', { hp: 10 }), S('Thick Skin', '+10 max life', { hp: 10 })],
      },
      {
        name: 'Old Growth', notable: S('Old Growth', '+25 max life · regenerate 1 more life every 2s', { hp: 25, regen: 1 }),
        smalls: [S('Ring of Years', '+12 max life', { hp: 12 }), S('Warm Blood', '+10 max life', { hp: 10 }), S('Deep Roots', '+10 max life', { hp: 10 })],
      },
    ],
    keystone: S('Second Wind', 'Once per dream, survive death with half your life', { cheatDeath: 1 }),
  },
  {
    key: 'fate', label: 'Fate',
    travel: [
      S('Clear Sight', '+3% spell damage, +3% cast speed', { dmg: 3, cast: 3 }),
      S('Dream Logic', '+3% essence gained', { xp: 3 }),
      S('Woven Fate', '+3% area of effect, +3% cast speed', { aoe: 3, cast: 3 }),
      S('Quiet Omen', '+3% spell damage, +3% area of effect', { dmg: 3, aoe: 3 }),
    ],
    notables: [
      S('The Refused Dream', 'You may banish one level-up offer each dream', { banish: 1 }),
      S('Woven Fate', '+8% spell damage, +8% cast speed', { dmg: 8, cast: 8 }),
    ],
    clusters: [
      {
        name: 'Loom of Nights', notable: S('Loom of Nights', 'You may reroll one set of level-up choices each dream', { reroll: 1 }),
        smalls: [S('Spindle', '+4% cast speed', { cast: 4 }), S('Thread of Dawn', '+3% essence gained', { xp: 3 }), S('Clear Sight', '+3% spell damage, +3% cast speed', { dmg: 3, cast: 3 })],
      },
      {
        name: 'The Second Refusal', notable: S('The Second Refusal', 'You may banish one more offer each dream', { banish: 1 }),
        smalls: [S('Closed Door', '+3% essence gained', { xp: 3 }), S('Dream Logic', '+3% essence gained', { xp: 3 }), S('Quiet Omen', '+3% spell damage, +3% area of effect', { dmg: 3, aoe: 3 })],
      },
      {
        name: 'Turning Page', notable: S('Turning Page', 'You may reroll one more set of choices each dream', { reroll: 1 }),
        smalls: [S('Dog-ear', '+3% essence gained', { xp: 3 }), S('Margin Note', '+3% spell damage, +3% cast speed', { dmg: 3, cast: 3 }), S('Woven Fate', '+3% area of effect, +3% cast speed', { aoe: 3, cast: 3 })],
      },
    ],
    keystone: S('Fourfold Path', 'Level-ups offer a fourth choice', { fourfold: 1 }),
  },
];

// tiny mixed travel stats for rings & the outer polygon (PoE's "attributes")
const GEN: Stat[] = [
  S('Faint Ember', '+3% spell damage', { dmg: 3 }),
  S('Silver Wisp', '+3% cast speed', { cast: 3 }),
  S('Pale Halo', '+3% area of effect', { aoe: 3 }),
  S('Dewlight', '+8 max life', { hp: 8 }),
  S('Moth Dust', '+6% pickup radius', { magnet: 6 }),
  S('Dream Mote', '+2% essence gained', { xp: 2 }),
  S('Night Breeze', '+2% move speed', { speed: 2 }),
  S('Sharp Glimmer', '+1% critical chance', { crit: 1 }),
];
const POLY: Stat[] = [
  S('Wayfarer’s Ember', '+4% spell damage', { dmg: 4 }),
  S('Wayfarer’s Breath', '+4% cast speed', { cast: 4 }),
  S('Wayfarer’s Halo', '+4% area of effect', { aoe: 4 }),
  S('Wayfarer’s Blood', '+12 max life', { hp: 12 }),
  S('Wayfarer’s Lure', '+8% pickup radius', { magnet: 8 }),
  S('Wayfarer’s Mote', '+3% essence gained', { xp: 3 }),
  S('Wayfarer’s Stride', '+3% move speed', { speed: 3 }),
  S('Wayfarer’s Glint', '+2% critical chance', { crit: 2 }),
];
let genIdx = 0;
const nextGen = (pool: Stat[]) => pool[genIdx++ % pool.length];

// ================================================================ main web
// 16 straight radial spokes (8 theme + 8 in-between) from an inner 16-gon,
// crossed by three ring roads with gaps, wrapped in a big outer polygon of
// travel stars, with stat wheels hung between the spokes and the spell
// constellations moored outside the polygon. Deliberately exact geometry —
// every diagonal, ring and wheel reads as a clean, symmetric figure.
const NSPOKE = 16;
const GATE_R = 72;
const SPOKE_R = [118, 164, 210, 256, 302, 348, 394, 440, 486, 532];
const POLY_R = 600;
// 20 clusters share the ring; at r=920 neighbouring constellations keep
// ~290 units between centres, so even the widest shapes never touch
const SPELL_RING_R = 920;

const spokeBase = (i: number) => -112.5 + i * 22.5;
const spokeAngle = (i: number, _step: number) => spokeBase(i); // exact radial rays — clean diagonals
const themeOf = (spoke: number) => THEMES[((spoke >> 1) % 8 + 8) % 8];

add({ id: 'core', x: 0, y: 0, name: 'The Waking Eye', desc: 'Where every dream begins. Touch it to forge a skill point from stardust — each costs more than the last.', fx: {}, kind: 'core' });

// --- inner 16-gon of gateways
for (let i = 0; i < NSPOKE; i++) {
  const a = deg(spokeBase(i));
  const th = themeOf(i);
  const st = i % 2 === 0 ? th.travel[0] : nextGen(GEN);
  add({ id: `g${i}`, x: Math.round(Math.cos(a) * GATE_R), y: Math.round(Math.sin(a) * GATE_R), name: st.n, desc: st.d, fx: st.fx, kind: 'small' });
  if (i % 2 === 0) link('core', `g${i}`);
}
for (let i = 0; i < NSPOKE; i++) linkArc(`g${i}`, `g${(i + 1) % NSPOKE}`, 4);

// --- spokes
for (let i = 0; i < NSPOKE; i++) {
  const th = themeOf(i);
  const thNext = THEMES[(((i + 1) >> 1) % 8 + 8) % 8];
  let prev = `g${i}`;
  for (let j = 0; j < SPOKE_R.length; j++) {
    const a = deg(spokeAngle(i, j));
    const r = SPOKE_R[j];
    let st: Stat, kind: NodeKind = 'small';
    if (i % 2 === 0 && (j === 3 || j === 7)) {
      st = th.notables[j === 3 ? 0 : 1];
      kind = 'notable';
    } else if (i % 2 === 0) {
      st = th.travel[j % th.travel.length];
    } else {
      // in-between spokes blend the two neighbouring schools
      st = (j % 2 === 0 ? th : thNext).travel[(j >> 1) % 4];
    }
    const id = add({ id: `s${i}-${j}`, x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r), name: st.n, desc: st.d, fx: st.fx, kind });
    link(prev, id, -5);
    prev = id;
  }
}

// --- ring roads: A (full), B and C (with gaps that force routing choices)
const ringNode = (id: string, r: number, aDeg: number, poolStat: Stat) =>
  add({ id, x: Math.round(Math.cos(deg(aDeg)) * r), y: Math.round(Math.sin(deg(aDeg)) * r), name: poolStat.n, desc: poolStat.d, fx: poolStat.fx, kind: 'small' });

for (let i = 0; i < NSPOKE; i++) { // ring A — the inner highway, complete
  const a = spokeAngle(i, 2) + 11.25;
  const id = ringNode(`rA${i}`, SPOKE_R[2], a, nextGen(GEN));
  linkArc(`s${i}-2`, id, 7);
  linkArc(id, `s${(i + 1) % NSPOKE}-2`, 7);
}
for (let i = 0; i < NSPOKE; i++) { // ring B — gaps at i%4==3
  if (i % 4 === 3) continue;
  const ids: string[] = [];
  for (let k = 0; k < 2; k++) {
    const a = spokeAngle(i, 5) + 7.5 + k * 7.5;
    ids.push(ringNode(`rB${i}-${k}`, SPOKE_R[5], a, nextGen(GEN)));
  }
  linkArc(`s${i}-5`, ids[0], 6);
  linkArc(ids[0], ids[1], 6);
  linkArc(ids[1], `s${(i + 1) % NSPOKE}-5`, 6);
}
for (let i = 0; i < NSPOKE; i++) { // ring C — gaps at i%4==1
  if (i % 4 === 1) continue;
  const ids: string[] = [];
  for (let k = 0; k < 2; k++) {
    const a = spokeAngle(i, 8) + 7.5 + k * 7.5;
    ids.push(ringNode(`rC${i}-${k}`, SPOKE_R[8], a, nextGen(GEN)));
  }
  linkArc(`s${i}-8`, ids[0], 7);
  // at the four spell-slot arcs the notable is spliced onto the ring between
  // these two stars (below), so skip the plain chord there — the road runs
  // rC-0 → notable → rC-1 instead
  if (i % 4 !== 3) linkArc(ids[0], ids[1], 7);
  linkArc(ids[1], `s${(i + 1) % NSPOKE}-8`, 7);
}

// --- the outer polygon: 16 vertices + 5 travel stars per side, all connected —
// the endgame highway that lets any build walk the rim to reach any cluster.
// Deliberately geometric: vertices sit exactly on the ring and every side star
// sits exactly on the chord, so the rim reads as one clean polygon.
const PV: [number, number][] = [];
for (let i = 0; i < NSPOKE; i++) {
  const a = deg(spokeAngle(i, 10));
  const x = Math.round(Math.cos(a) * POLY_R), y = Math.round(Math.sin(a) * POLY_R);
  PV.push([x, y]);
  const st = POLY[i % POLY.length];
  add({ id: `pv${i}`, x, y, name: st.n, desc: st.d, fx: st.fx, kind: 'small' });
  link(`s${i}-9`, `pv${i}`);
}
for (let i = 0; i < NSPOKE; i++) {
  const [ax, ay] = PV[i], [bx, by] = PV[(i + 1) % NSPOKE];
  let prev = `pv${i}`;
  for (let k = 1; k <= 5; k++) {
    const t = k / 6;
    const st = nextGen(POLY);
    const id = add({ id: `ps${i}-${k}`, x: Math.round(ax + (bx - ax) * t), y: Math.round(ay + (by - ay) * t), name: st.n, desc: st.d, fx: st.fx, kind: 'small' });
    link(prev, id);
    prev = id;
  }
  link(prev, `pv${(i + 1) % NSPOKE}`);
}

// --- stat wheels between the spokes
// A wheel: a ring of small stars with the notable enthroned at the hub. The
// empty heart of the wheel is exactly the breathing room a big star needs —
// it never crowds a neighbour, and reaching it means walking half the ring.
let wheelCounter = 0;
function wheel(hostId: string, centerAngleDeg: number, centerR: number, radius: number, count: number, cdef: ClusterDef) {
  const host = byId[hostId];
  const cx = Math.cos(deg(centerAngleDeg)) * centerR, cy = Math.sin(deg(centerAngleDeg)) * centerR;
  const back = Math.atan2(host.y - cy, host.x - cx);
  const wid = `w${wheelCounter++}`;
  const n = count - 1; // ring smalls; the remaining star is the hub notable
  const ids: string[] = [];
  for (let k = 0; k < n; k++) {
    const na = back + (k / n) * Math.PI * 2;
    const st = cdef.smalls[k % cdef.smalls.length];
    ids.push(add({ id: `${wid}-${k}`, x: Math.round(cx + Math.cos(na) * radius), y: Math.round(cy + Math.sin(na) * radius), name: st.n, desc: st.d, fx: st.fx, kind: 'small' }));
  }
  for (let k = 0; k < n; k++) link(ids[k], ids[(k + 1) % n]);
  link(hostId, ids[0]);
  const hub = add({ id: `${wid}-N`, x: Math.round(cx), y: Math.round(cy), name: cdef.notable.n, desc: cdef.notable.d, fx: cdef.notable.fx, kind: 'notable' });
  link(ids[Math.floor((n - 1) / 2)], hub);
  link(hub, ids[Math.ceil((n + 1) / 2) % n]);
}

// band 2 (between rings A and B): wheels off ring A, centred between the
// spokes so they never clip them — skip 4 slots for irregularity
for (let i = 0; i < NSPOKE; i++) {
  if (i % 4 === 2) continue;
  const th = themeOf(i);
  const cdef = th.clusters[(i >> 1) % th.clusters.length];
  wheel(`rA${i}`, spokeAngle(i, 3) + 11.25, 284, 35, 5, cdef);
}
// band 3 (between rings B and C)
for (let i = 0; i < NSPOKE; i++) {
  if (i % 4 === 3) continue; // no ring B here (the spell-slot chains live in these gaps)
  const th = themeOf(i);
  const cdef = th.clusters[((i >> 1) + 1) % th.clusters.length];
  wheel(`rB${i}-${i % 2}`, spokeAngle(i, 6) + 11.25, 420, 40, 6, cdef);
}

// --- spell-slot chains in the ring-B gaps: three +1-slot notables (the build-
// defining picks) plus one economy notable, each behind a short chain
const GAP_CHAINS: { id: string; steps: Stat[]; end: Stat }[] = [
  { id: 'ssA', steps: [S('Open Palm', '+4% area of effect', { aoe: 4 }), S('Open Mind', '+4% spell damage', { dmg: 4 })], end: S('Unbound Firmament', '+1 spell slot — hold one more spell at once', { spellSlots: 1 }) },
  { id: 'ssB', steps: [S('Open Door', '+3% essence gained', { xp: 3 }), S('Open Sky', '+8% pickup radius', { magnet: 8 })], end: S('Boundless Reverie', '+1 spell slot — hold one more spell at once', { spellSlots: 1 }) },
  { id: 'ssC', steps: [S('Open Book', '+4% cast speed', { cast: 4 }), S('Open Heart', '+10 max life', { hp: 10 })], end: S('Widening Loom', '+1 spell slot — hold one more spell at once', { spellSlots: 1 }) },
  { id: 'ssD', steps: [S('Loose Change', '+3% essence gained', { xp: 3 }), S('Silver Tongue', '+6% pickup radius', { magnet: 6 })], end: S('The Quiet Bargain', '+15% stardust earned', { dust: 15 }) },
];
{
  const gaps = [3, 7, 11, 15]; // ring-B gap arcs
  gaps.forEach((i, gi) => {
    const chain = GAP_CHAINS[gi];
    let prev = `s${i}-5`;
    const baseA = spokeAngle(i, 6) + 11.25;
    // two smalls climb the band between ring B and ring C, evenly spaced
    chain.steps.forEach((st, k) => {
      const r = 384 + k * 44; // 384, 428
      const id = add({ id: `${chain.id}-${k}`, x: Math.round(Math.cos(deg(baseA)) * r), y: Math.round(Math.sin(deg(baseA)) * r), name: st.n, desc: st.d, fx: st.fx, kind: 'small' });
      link(prev, id, -5);
      prev = id;
    });
    // the notable is woven straight INTO ring C, taking the road's midpoint
    // between the arc's two ring stars (rC-0 at +7.5°, rC-1 at +15°): a prominent
    // station ON the highway rather than a squished stub dangling inside it. The
    // chain climbs up to it from below; the ring now runs rC-0 → notable → rC-1,
    // so no radial edge ever crosses the ring road.
    const id = add({ id: `${chain.id}-N`, x: Math.round(Math.cos(deg(baseA)) * SPOKE_R[8]), y: Math.round(Math.sin(deg(baseA)) * SPOKE_R[8]), name: chain.end.n, desc: chain.end.d, fx: chain.end.fx, kind: 'notable' });
    link(prev, id);
    linkArc(`rC${i}-0`, id);
    linkArc(id, `rC${i}-1`);
  });
}

// --- keystones: one per school, floating alone in the corridor between
// ring C and the polygon. No gate star crowding them — they hang on two
// long edges (up to the rim, down to ring C) with clear space all around.
for (let t = 0; t < 8; t++) {
  const th = THEMES[t];
  const i = t * 2; // arc index inside the theme's sector
  const a = deg(spokeAngle(i, 9) + 11.25);
  const kid = add({ id: `k${t}`, x: Math.round(Math.cos(a) * 540), y: Math.round(Math.sin(a) * 540), name: th.keystone.n, desc: th.keystone.d, fx: th.keystone.fx, kind: 'keystone' });
  link(`ps${i}-3`, kid);        // from the polygon side above
  linkArc(kid, `rC${i}-1`);     // and from ring C below (always present on even arcs)
}

// ================================================================ spell clusters
// The spell constellations keep their hand-drawn shapes but are moored to the
// outer polygon, one slot per spell, spaced evenly however many there are —
// twenty schools of the dream and counting.
const AOE_SPELLS = [
  'ember', 'frost', 'void', 'petals', 'moon', 'starfall', 'nebula', 'sigil', 'lantern', 'nova',
  'serpent', 'chime', 'eye', 'ward', 'hush',
];
const DUR_SPELLS = [
  'frost', 'void', 'nebula', 'sigil', 'lantern',
  'serpent', 'eye', 'brand', 'prism', 'hush',
];

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
    { n: 'Creeping Cold', d: 'Bosses can be slowed too, at half strength.', special: { bossChill: 1 } },
    { n: 'Brittle Dreams', d: 'Slowed foes take 15% more damage from everything.', special: { chillAmp: 15 } },
  ],
  storm: [
    { n: 'Longer Ladder', d: 'Lightning leaps one more time.', scount: 1 },
    { n: 'Persistent Charge', d: 'Chains fade far less with each leap.', special: { falloff: 1 } },
  ],
  void: [
    { n: 'Deeper Hunger', d: 'Rifts pull 50% harder.', special: { pull: 50 } },
    { n: 'Inevitable Gravity', d: 'Bosses are pulled toward the rift too.', special: { bossPull: 1 } },
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
    { n: 'Whispering Mist', d: 'The cloud slows foes inside it.', special: { slowIn: 25 } },
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
    { n: 'Dissolving Dusk', d: 'The wave destroys enemy shots it passes over (10% chance).', special: { dissolve: 10 } },
  ],
  wisps: [
    { n: 'Fourth Voice', d: '+1 wisp joins the choir.', scount: 1 },
    { n: 'Eager Chorus', d: 'Wisps dart 25% faster and lunge farther.', special: { dartHaste: 25 } },
  ],
  serpent: [
    { n: 'Long Coils', d: 'The serpent is 40% longer.', special: { longer: 40 } },
    { n: 'Salt Hunger', d: 'Each kill feeds the serpent half a second of life.', special: { feed: 1 } },
  ],
  chime: [
    { n: 'Deep Resonance', d: 'Every third toll is the crescendo.', special: { res3: 1 } },
    { n: 'Struck Silver', d: 'The crescendo briefly stuns all it touches.', special: { stun: 1 } },
  ],
  eye: [
    { n: 'Slow Dawn', d: 'The beam sweeps an extra half-turn.', special: { turns: 1 } },
    { n: 'Blinding Light', d: 'The beam’s first touch staggers foes.', special: { stun: 1 } },
  ],
  brand: [
    { n: 'Old Grudge', d: 'The brand lasts 2 seconds longer.', special: { vigil: 2 } },
    { n: 'Written in Ash', d: 'Branded foes take 10% more damage from everything.', special: { ash: 10 } },
  ],
  prism: [
    { n: 'Twin Facet', d: 'The prism fires two rays a volley, at different foes.', special: { facet: 1 } },
    { n: 'Patient Light', d: 'The prism hangs in the air 2 seconds longer.', special: { vigil: 2 } },
  ],
  ward: [
    { n: 'Bright Facets', d: 'Wards soak a third more damage before they break.', special: { temper: 33 } },
    { n: 'Answering Glass', d: 'Bosses are knocked back by the shatter too.', special: { bossKnock: 1 } },
  ],
  hush: [
    { n: 'Leaden Limbs', d: 'The slow is a third stronger.', special: { leaden: 33 } },
    { n: 'Distant Dreaming', d: 'Each pulse throws foes farther and staggers them.', special: { stun: 1 } },
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
  // a rising spiral — the procession of the choir, its heart the evolution
  wisps: {
    pts: [[0, 115], [-87, 61], [-91, -33], [-23, -85], [51, -61], [70, 6], [31, 53], [-22, 47], [-42, 7], [-24, -24], [4, -25], [15, -7]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11]],
    roles: { entry: 0, evo: 11, start: 5, med: [3, 8] },
  },
  // an S of stars swimming upward, head crowned, fins trailing
  serpent: {
    pts: [[0, 115], [38, 88], [54, 52], [40, 16], [0, -4], [-40, -24], [-54, -60], [-38, -92], [0, -112], [26, -104], [78, 44], [-78, -72]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [2, 10], [6, 11]],
    roles: { entry: 0, evo: 8, start: 4, med: [10, 11] },
  },
  // a bell in outline, the clapper hanging at its heart
  chime: {
    pts: [[0, 115], [-58, 86], [58, 86], [-64, 60], [64, 60], [-52, 10], [52, 10], [-30, -52], [30, -52], [0, -78], [0, -112], [0, 62]],
    edges: [[0, 1], [0, 2], [1, 3], [3, 5], [5, 7], [7, 9], [9, 8], [8, 6], [6, 4], [4, 2], [9, 10], [0, 11], [11, 9]],
    roles: { entry: 0, evo: 11, start: 10, med: [3, 4] },
  },
  // an open eye, iris at centre, three rays of its gaze
  eye: {
    pts: [[0, 115], [-100, 10], [100, 10], [-52, -28], [0, -42], [52, -28], [-52, 44], [52, 44], [0, 0], [0, -88], [-78, -72], [78, -72]],
    edges: [[0, 6], [0, 7], [6, 1], [1, 3], [3, 4], [4, 5], [5, 2], [7, 2], [6, 8], [7, 8], [8, 4], [4, 9], [3, 10], [5, 11]],
    roles: { entry: 0, evo: 8, start: 9, med: [10, 11] },
  },
  // a jagged rune-scar cut stroke by stroke into the dark
  brand: {
    pts: [[0, 115], [-20, 78], [28, 52], [-28, 20], [30, -10], [-24, -42], [26, -72], [0, -108], [-70, 60], [66, -46], [-58, -80], [60, 90]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [1, 8], [6, 9], [5, 10], [0, 11], [11, 2]],
    roles: { entry: 0, evo: 7, start: 10, med: [8, 9] },
  },
  // a glass triangle: one ray enters below, a fan of light leaves the apex
  prism: {
    pts: [[0, 115], [0, 68], [0, 20], [-52, 20], [52, 20], [0, -70], [-26, -24], [26, -24], [-52, -108], [0, -116], [52, -108], [0, -30]],
    edges: [[0, 1], [1, 2], [2, 3], [2, 4], [3, 6], [6, 5], [4, 7], [7, 5], [2, 11], [11, 5], [5, 8], [5, 9], [5, 10]],
    roles: { entry: 0, evo: 9, start: 5, med: [8, 10] },
  },
  // a heraldic shield: point below faces the heart, crowned above, a boss at
  // its centre (the evolution) and two flanks (the notables)
  ward: {
    pts: [[0, 115], [42, 72], [72, 22], [80, -40], [58, -92], [0, -112], [-58, -92], [-80, -40], [-72, 22], [-42, 72], [0, -30], [0, 34]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 0], [11, 0], [10, 11], [5, 10], [10, 2], [10, 8]],
    roles: { entry: 0, evo: 10, start: 5, med: [2, 8] },
  },
  // a sleeping crescent moon cupping two drifting sleep-motes to the right
  hush: {
    pts: [[0, 115], [-42, 92], [-72, 52], [-86, 2], [-74, -48], [-38, -92], [6, -112], [-10, -64], [-34, -14], [-40, 40], [50, -82], [74, -40]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 0], [6, 10], [10, 11]],
    roles: { entry: 0, evo: 10, start: 6, med: [8, 11] },
  },
};

// Moorings are spread perfectly evenly around the rim, so the rim-walk
// between any two neighbouring clusters is (as near as the rim's star
// spacing allows) the same. A future spell just joins CLUSTER_ORDER and the
// spacing recomputes itself. Ordered so thematic siblings sit side by side
// (moths beside the moon, the wake beside the stars, the brand in the dark…)
const CLUSTER_ORDER = [
  'starfall', 'moon', 'hush', 'frost', 'serpent', 'storm', 'chime',
  'arcane', 'ember', 'void', 'brand', 'umbra', 'glaive',
  'prism', 'nebula', 'eye', 'sigil', 'ward', 'lantern', 'wisps', 'petals', 'nova',
];

{
  CLUSTER_ORDER.forEach((spellId, slot) => {
    const s = SPELLS[spellId];
    const spec = SHAPES[spellId];
    const meds = MEDIUMS[spellId];
    const thetaDeg = -90 + slot * (360 / CLUSTER_ORDER.length);
    const theta = deg(thetaDeg);
    const cx = Math.cos(theta) * SPELL_RING_R, cy = Math.sin(theta) * SPELL_RING_R;
    // rotate the shape so its entry star lands exactly on the ray toward the
    // tree's heart — moorings then sit at perfectly even angles on the rim
    const [epx, epy] = spec.pts[spec.roles.entry];
    const rho = theta + Math.PI - Math.atan2(epy, epx);
    const cosR = Math.cos(rho), sinR = Math.sin(rho);
    const world = spec.pts.map(([px, py]) => [
      Math.round(cx + px * cosR - py * sinR),
      Math.round(cy + px * sinR + py * cosR),
    ] as [number, number]);
    const hasAoe = AOE_SPELLS.includes(spellId);
    const hasDur = DUR_SPELLS.includes(spellId);
    const isDef = s.kind === 'defense';
    // defensive spells have no "damage"; the same mote slots (sdmg/scd/saoe/sdur)
    // instead read as strength / quickening / radius / hold and are folded onto
    // the ward's shield & mending (see Engine.spellStats)
    const dmgWord = isDef ? 'strength' : 'damage';
    const cdWord = isDef ? 'recharge' : 'cast speed';
    const aoeWord = isDef ? 'radius' : 'area';
    const durWord = isDef ? 'hold' : 'duration';
    const smallTpl = [
      { d: `+8% ${s.name} ${dmgWord}`, fx: { sdmg: 8 } },
      { d: `+6% ${s.name} ${cdWord}`, fx: { scd: 6 } },
      hasAoe ? { d: `+8% ${s.name} ${aoeWord}`, fx: { saoe: 8 } } : { d: `+8% ${s.name} ${dmgWord}`, fx: { sdmg: 8 } },
      { d: `+8% ${s.name} ${dmgWord}`, fx: { sdmg: 8 } },
      hasDur ? { d: `+12% ${s.name} ${durWord}`, fx: { sdur: 12 } } : (hasAoe ? { d: `+8% ${s.name} ${aoeWord}`, fx: { saoe: 8 } } : { d: `+6% ${s.name} ${cdWord}`, fx: { scd: 6 } }),
      { d: `+6% ${s.name} ${cdWord}`, fx: { scd: 6 } },
      { d: `+10% ${s.name} ${dmgWord}`, fx: { sdmg: 10 } },
    ];
    let smallIdx = 0;
    world.forEach((pt, i) => {
      let def: { kind: NodeKind; name: string; desc: string; fx: Record<string, any> };
      if (i === spec.roles.entry) {
        def = { kind: 'small', name: `Dream of ${s.name}`, desc: `${s.name} appears more often in your level-up choices.`, fx: { spell: spellId, weight: 1 } };
      } else if (i === spec.roles.evo) {
        def = { kind: 'keystone', name: EVOLVE[spellId].name, desc: `Unlock ${s.name}'s evolution: ${EVOLVE[spellId].desc}`, fx: { spell: spellId, evo: 1 } };
      } else if (i === spec.roles.start) {
        def = spellId === LOADOUT_BASE
          ? { kind: 'notable', name: `Waking ${s.icon}`, desc: `Begin every dream with ${s.name} one level stronger.`, fx: { spell: spellId, startLv: 1 } }
          : { kind: 'notable', name: `Dream-Etched ${s.icon}`, desc: `Unlock ${s.name} for your loadout — carry it into every dream.`, fx: { spell: spellId, unlock: 1 } };
      } else if (spec.roles.med.includes(i)) {
        const m = meds[spec.roles.med.indexOf(i)];
        const fx: Record<string, any> = { spell: spellId };
        if (m.scount) fx.scount = m.scount;
        if (m.special) fx.special = m.special;
        def = { kind: 'notable', name: m.n, desc: m.d, fx };
      } else {
        const t = smallTpl[smallIdx % smallTpl.length];
        smallIdx++;
        def = { kind: 'small', name: `Mote of ${s.name}`, desc: t.d, fx: { spell: spellId, ...t.fx } };
      }
      add({ id: `${spellId}-${i}`, x: pt[0], y: pt[1], ...def });
    });
    for (const [i, j, bend] of spec.edges) link(`${spellId}-${i}`, `${spellId}-${j}`, bend);

    // mooring bridge: entry star → the rim star angularly closest to the
    // cluster's ray (nearest-by-distance flip-flops near polygon corners,
    // which unbalances the rim-walk between neighbouring clusters)
    const [ex, ey] = world[spec.roles.entry];
    let bestId = 'pv0', bestD = Infinity;
    for (const n of nodes) {
      if (!n.id.startsWith('pv') && !n.id.startsWith('ps')) continue;
      let da = (Math.atan2(n.y, n.x) - theta) % (Math.PI * 2);
      if (da < 0) da += Math.PI * 2;
      da = Math.min(da, Math.PI * 2 - da);
      if (da < bestD) { bestD = da; bestId = n.id; }
    }
    // two travel stars carry the longer walk out to the constellation
    const host = byId[bestId];
    let prev = bestId;
    for (let k = 1; k <= 2; k++) {
      const f = k / 3;
      const st = nextGen(GEN);
      const bid = add({ id: `br-${spellId}-${k}`, x: Math.round(host.x + (ex - host.x) * f), y: Math.round(host.y + (ey - host.y) * f), name: st.n, desc: st.d, fx: st.fx, kind: 'small' });
      link(prev, bid, 4);
      prev = bid;
    }
    link(prev, `${spellId}-${spec.roles.entry}`, 4);
  });
}

export const CONST_NODES: TreeNode[] = [...nodes];
export const CONST_EDGES: TreeEdge[] = [...edges];

// ====================================================== the dark bargain
// A small corrupted sigil of its own. Every small star starts the dream
// deeper — the timer (and your best time) begins there. Notables and the two
// black keystones trade harsher nightmares for richer stardust.
const darkStart = nodes.length;
const darkEdgeStart = edges.length;

const DS = (id: string, r: number, aDeg: number, kind: NodeKind, name: string, desc: string, fx: Record<string, any>) =>
  add({ id, x: Math.round(Math.cos(deg(aDeg)) * r), y: Math.round(Math.sin(deg(aDeg)) * r), kind, name, desc, fx, dark: true });

DS('dark-core', 0, 0, 'core', 'The Wound', 'A tear in the dream that never closed. Feed it a nightmare shard to draw out a drop of its power — each drop costs one shard more.', {});

{
  const veins = [
    { a: -90, notable: { n: 'Cruel Dawn', d: '+30% stardust earned · enemies strike 20% harder', fx: { dust: 30, baneDmg: 20 } } },
    { a: 30, notable: { n: 'Iron Nightmares', d: '+30% stardust earned · enemies have +25% life', fx: { dust: 30, baneHp: 25 } } },
    { a: 150, notable: { n: 'Fleet Shadows', d: '+30% stardust earned · enemies move 15% faster', fx: { dust: 30, baneSpeed: 15 } } },
  ];
  const depth = [20, 25, 30];
  veins.forEach((v, vi) => {
    let prev = 'dark-core';
    for (let j = 0; j < 3; j++) {
      const a = v.a + (j % 2 ? 7 : -7);
      const id = DS(`dark-v${vi}-${j}`, 62 + j * 54, a, 'small', 'Sunken Hour', `The dream begins ${depth[j]} seconds deeper · +9% stardust earned`, { baneAhead: depth[j], dust: 9 });
      link(prev, id, j % 2 ? 6 : -6);
      prev = id;
    }
    const nid = DS(`dark-n${vi}`, 226, v.a, 'notable', v.notable.n, v.notable.d, v.notable.fx);
    link(prev, nid, -5);
  });
  // inner ring joining the veins' first stars
  for (let vi = 0; vi < 3; vi++) {
    const a = veins[vi].a + 60;
    const id = DS(`dark-i${vi}`, 78, a, 'small', 'Stolen Minute', 'The dream begins 15 seconds deeper · +8% stardust earned', { baneAhead: 15, dust: 8 });
    linkArc(`dark-v${vi}-0`, id, 8);
    linkArc(id, `dark-v${(vi + 1) % 3}-0`, 8);
  }
  // outer arcs joining the notables, with a bane notable at each arc's middle
  const arcNotables = [
    { n: 'Restless Horde', d: '+27% stardust earned · the tide spawns 20% faster', fx: { dust: 27, baneRate: 20 } },
    { n: 'Hungry Dark', d: '+27% stardust earned · elites stir 50% more often', fx: { dust: 27, baneElite: 50 } },
    { n: 'Devourer’s Haste', d: '+27% stardust earned · the Devourer comes 40% sooner', fx: { dust: 27, baneBoss: 40 } },
  ];
  for (let vi = 0; vi < 3; vi++) {
    const a0 = veins[vi].a;
    const ids = [
      DS(`dark-a${vi}-0`, 248, a0 + 38, 'small', 'Drowned Hour', 'The dream begins 30 seconds deeper · +12% stardust earned', { baneAhead: 30, dust: 12 }),
      DS(`dark-a${vi}-1`, 248, a0 + 82, 'small', 'Drowned Hour', 'The dream begins 30 seconds deeper · +12% stardust earned', { baneAhead: 30, dust: 12 }),
    ];
    linkArc(`dark-n${vi}`, ids[0], 10);
    linkArc(ids[0], ids[1], 10);
    linkArc(ids[1], `dark-n${(vi + 1) % 3}`, 10);
    const m = arcNotables[vi];
    const mid = DS(`dark-m${vi}`, 316, a0 + 60, 'notable', m.n, m.d, m.fx);
    linkArc(ids[0], mid, -6);
    linkArc(ids[1], mid, 6);
  }
  // the three black keystones, one past each bane notable
  const k0 = DS('dark-k0', 392, 90, 'keystone', 'The Black Star', '+60% stardust earned · enemies have +30% life and strike 25% harder', { dust: 60, baneHp: 30, baneDmg: 25 });
  linkArc('dark-m1', k0, -8); // m1 sits at 90°
  const k1 = DS('dark-k1', 392, 210, 'keystone', 'The Hungering Deep', '+45% stardust earned · the dream begins 120 seconds deeper · at least 12 more enemies swarm you at all times', { dust: 45, baneAhead: 120, baneFloor: 12 });
  linkArc('dark-m2', k1, -8); // m2 sits at 210°
  const k2 = DS('dark-k2', 392, -30, 'keystone', 'The Red Choir', '+53% stardust earned · elites stir 60% more often · the Devourer comes 30% sooner', { dust: 53, baneElite: 60, baneBoss: 30 });
  linkArc('dark-m0', k2, -8); // m0 sits at -30°
}

export const DARK_NODES: TreeNode[] = nodes.slice(darkStart);
export const DARK_EDGES: TreeEdge[] = edges.slice(darkEdgeStart);

// ---------------------------------------------------------------- indices
export const TREE_NODES = nodes; // all nodes, both webs
export const NODE_MAP: Record<string, TreeNode> = byId;

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

// undirected adjacency: owning either endpoint of an edge opens the other
export const ADJACENT: Record<string, string[]> = (() => {
  const adj: Record<string, string[]> = {};
  for (const [a, b] of TREE_EDGES) {
    (adj[a] = adj[a] || []).push(b);
    (adj[b] = adj[b] || []).push(a);
  }
  return adj;
})();

// ---------------------------------------------------------------- storage
function freshMeta(): Meta {
  return {
    dust: 0, shards: 0,
    points: 0, pointsBought: 0, darkPoints: 0, darkPointsBought: 0,
    owned: ['core'], darkOwned: ['dark-core'],
    best: 0, loadout: [LOADOUT_BASE],
    treeRevealed: false, darkRevealed: false,
  };
}

// v3 → v4: the old tree spent currency directly on nodes. Every coin comes
// back; the trees stay revealed; nothing stays allocated.
function migrateLegacy(): Meta | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    const owned: string[] = Array.isArray(d.owned) ? d.owned : [];
    let dustBack = 0, shardsBack = 0, hadDark = false;
    for (const id of owned) {
      const c = LEGACY_COSTS[id] || 0;
      if (String(id).startsWith('dark-')) { shardsBack += c; hadDark = true; }
      else dustBack += c;
    }
    const meta = freshMeta();
    meta.dust = (d.dust || 0) + dustBack;
    meta.shards = (d.shards || 0) + shardsBack;
    meta.best = d.best || 0;
    meta.treeRevealed = d.treeRevealed !== undefined
      ? !!d.treeRevealed
      : owned.length > 1 || (d.dust || 0) > 0 || (d.best || 0) > 0;
    meta.darkRevealed = hadDark;
    return meta;
  } catch { return null; }
}

export function loadMeta(): Meta {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      // stars that no longer exist after a layout change refund their point —
      // a save must never lose value to a redesign
      const rawOwned: string[] = Array.isArray(d.owned) ? d.owned : ['core'];
      const rawDark: string[] = Array.isArray(d.darkOwned) ? d.darkOwned : ['dark-core'];
      const owned = rawOwned.filter((id) => NODE_MAP[id] && !NODE_MAP[id].dark);
      const darkOwned = rawDark.filter((id) => NODE_MAP[id] && NODE_MAP[id].dark);
      const meta: Meta = {
        dust: d.dust || 0, shards: d.shards || 0,
        points: (d.points || 0) + (rawOwned.length - owned.length),
        pointsBought: d.pointsBought || 0,
        darkPoints: (d.darkPoints || 0) + (rawDark.length - darkOwned.length),
        darkPointsBought: d.darkPointsBought || 0,
        owned, darkOwned,
        best: d.best || 0,
        loadout: Array.isArray(d.loadout) ? d.loadout : [LOADOUT_BASE],
        treeRevealed: !!d.treeRevealed,
        darkRevealed: !!d.darkRevealed,
      };
      if (!meta.owned.includes('core')) meta.owned.unshift('core');
      if (!meta.darkOwned.includes('dark-core')) meta.darkOwned.unshift('dark-core');
      meta.loadout = sanitizeLoadout(meta);
      return meta;
    }
  } catch { /* corrupted store — fall through */ }
  const migrated = migrateLegacy();
  if (migrated) { saveMeta(migrated); return migrated; }
  return freshMeta();
}

export function saveMeta(meta: Meta) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(meta)); } catch { /* private mode */ }
}

// -------------------------------------------------------- skill point forge
// The core of each web mints skill points. Constellation: the very first is a
// gift (so the first touch of the Waking Eye always wakes a point), then a
// flat +5 ✦ per point ever bought after. Dark Bargain: 1 ❖, then +1 ❖ per point.
export function nextPointCost(meta: Meta): number {
  const n = meta.pointsBought;
  if (n === 0) return 0;
  return 5 * n;
}
export function nextDarkPointCost(meta: Meta): number { return 1 + meta.darkPointsBought; }

export function canBuyPoint(meta: Meta): boolean {
  return meta.dust >= nextPointCost(meta) && !settings.devFreeTree;
}
export function buyPoint(meta: Meta): Meta {
  if (!canBuyPoint(meta)) return meta;
  const next = { ...meta, dust: meta.dust - nextPointCost(meta), points: meta.points + 1, pointsBought: meta.pointsBought + 1 };
  saveMeta(next);
  return next;
}
export function canBuyDarkPoint(meta: Meta): boolean {
  return meta.shards >= nextDarkPointCost(meta) && !settings.devFreeTree;
}
export function buyDarkPoint(meta: Meta): Meta {
  if (!canBuyDarkPoint(meta)) return meta;
  const next = { ...meta, shards: meta.shards - nextDarkPointCost(meta), darkPoints: meta.darkPoints + 1, darkPointsBought: meta.darkPointsBought + 1 };
  saveMeta(next);
  return next;
}

// -------------------------------------------------------------- allocation
const ownedListFor = (meta: Meta, id: string) => (NODE_MAP[id]?.dark ? meta.darkOwned : meta.owned);
const pointsFor = (meta: Meta, id: string) => (NODE_MAP[id]?.dark ? meta.darkPoints : meta.points);

// a star with a lit neighbour (ignores whether a point is available)
export function isReachable(meta: Meta, id: string): boolean {
  const list = ownedListFor(meta, id);
  return (ADJACENT[id] || []).some((r) => list.includes(r));
}

export function canAllocate(meta: Meta, id: string): boolean {
  const n = NODE_MAP[id];
  if (!n || n.kind === 'core') return false;
  if (ownedListFor(meta, id).includes(id)) return false;
  if (!settings.devFreeTree && pointsFor(meta, id) <= 0) return false;
  return isReachable(meta, id);
}

export function allocateNode(meta: Meta, id: string): Meta {
  if (!canAllocate(meta, id)) return meta;
  const n = NODE_MAP[id];
  const spend = settings.devFreeTree ? 0 : 1;
  const next: Meta = n.dark
    ? { ...meta, darkOwned: [...meta.darkOwned, id], darkPoints: meta.darkPoints - spend }
    : { ...meta, owned: [...meta.owned, id], points: meta.points - spend };
  next.loadout = sanitizeLoadout(next);
  saveMeta(next);
  return next;
}

// Stars whose removal keeps the lit web connected to its core — i.e. every
// owned non-core star that is not an articulation point of the owned
// subgraph. Recomputed once per allocation change, not per node.
export function removableSet(ownedIds: string[], coreId: string): Set<string> {
  const owned = new Set(ownedIds);
  const idx = new Map<string, number>();
  ownedIds.forEach((id, i) => idx.set(id, i));
  const n = ownedIds.length;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const isArt = new Uint8Array(n);
  let timer = 0;
  const rootIdx = idx.get(coreId);
  const out = new Set<string>();
  if (rootIdx === undefined) return out;
  // iterative DFS from the core over the owned subgraph
  const stack: [number, number][] = [[rootIdx, -1]];
  const childIter = new Map<number, number>();
  const parents = new Int32Array(n).fill(-1);
  const rootChildren = { count: 0 };
  while (stack.length) {
    const [u] = stack[stack.length - 1];
    if (disc[u] === -1) { disc[u] = low[u] = timer++; }
    const uid = ownedIds[u];
    const nbrs = ADJACENT[uid] || [];
    let k = childIter.get(u) || 0;
    let advanced = false;
    while (k < nbrs.length) {
      const vid = nbrs[k];
      k++;
      if (!owned.has(vid)) continue;
      const v = idx.get(vid)!;
      if (disc[v] === -1) {
        parents[v] = u;
        if (u === rootIdx) rootChildren.count++;
        childIter.set(u, k);
        stack.push([v, u]);
        advanced = true;
        break;
      } else if (v !== parents[u]) {
        low[u] = Math.min(low[u], disc[v]);
      }
    }
    if (advanced) continue;
    childIter.set(u, k);
    stack.pop();
    const p: number = parents[u];
    if (p !== -1) {
      low[p] = Math.min(low[p], low[u]);
      if (p !== rootIdx && low[u] >= disc[p]) isArt[p] = 1;
    }
  }
  if (rootChildren.count > 1) isArt[rootIdx] = 1;
  for (let i = 0; i < n; i++) {
    const id = ownedIds[i];
    if (id === coreId) continue;
    if (disc[i] === -1) { out.add(id); continue; } // disconnected leftovers can always go
    if (!isArt[i]) out.add(id);
  }
  return out;
}

export function canDeallocate(meta: Meta, id: string): boolean {
  const n = NODE_MAP[id];
  if (!n || n.kind === 'core') return false;
  const list = ownedListFor(meta, id);
  if (!list.includes(id)) return false;
  return removableSet(list, n.dark ? 'dark-core' : 'core').has(id);
}

// releasing a star returns its skill point — never the currency
export function deallocateNode(meta: Meta, id: string): Meta {
  if (!canDeallocate(meta, id)) return meta;
  const n = NODE_MAP[id];
  const refund = settings.devFreeTree ? 0 : 1;
  const next: Meta = n.dark
    ? { ...meta, darkOwned: meta.darkOwned.filter((o) => o !== id), darkPoints: meta.darkPoints + refund }
    : { ...meta, owned: meta.owned.filter((o) => o !== id), points: meta.points + refund };
  next.loadout = sanitizeLoadout(next);
  saveMeta(next);
  return next;
}

export function markTreeRevealed(meta: Meta): Meta {
  if (meta.treeRevealed) return meta;
  const next = { ...meta, treeRevealed: true };
  saveMeta(next);
  return next;
}

export function markDarkRevealed(meta: Meta): Meta {
  if (meta.darkRevealed) return meta;
  const next = { ...meta, darkRevealed: true };
  saveMeta(next);
  return next;
}

export function setLoadout(meta: Meta, loadout: string[]): Meta {
  const next = { ...meta, loadout };
  next.loadout = sanitizeLoadout(next);
  saveMeta(next);
  return next;
}

// total head start (seconds) the Dark Bargain grants
export function darkDepth(meta: Meta): number {
  let s = 0;
  for (const id of meta.darkOwned) {
    const n = NODE_MAP[id];
    if (n && n.fx.baneAhead) s += n.fx.baneAhead as number;
  }
  return s;
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
  for (const id of [...meta.owned, ...meta.darkOwned]) {
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
  b.regen = Math.round(b.regen * 2) / 2;
  return b;
}

export interface RunResult { time: number; kills: number; level: number; bonusDust?: number; shards?: number }

export function dustForRun(result: RunResult, bonuses: Partial<Bonuses>): number {
  const base = result.kills * 0.35 + result.level * 3 + result.time / 6;
  return Math.max(1, Math.round(base * (1 + (bonuses.dust || 0) / 100)) + (result.bonusDust || 0));
}
