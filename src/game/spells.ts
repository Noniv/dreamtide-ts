// The schools of the dream. Each spell keeps a unique identity in color,
// motion, sound and particle language. Most strike the horde; a few (kind:
// 'defense') only shelter the dreamer. Cast logic lives in the engine.

export interface SpellStats {
  cooldown: number;
  damage?: number;
  dps?: number;
  count?: number;
  radius?: number;
  speed?: number;
  slow?: number;
  slowDur?: number;
  chains?: number;
  range?: number;
  pull?: number;
  duration?: number;
  width?: number;
  length?: number;
  beams?: number;
  sleepDur?: number;
  knock?: number;
  interval?: number;
  turns?: number;
  // defensive spells (kind: 'defense'):
  shield?: number;        // harm the ward can drink before it breaks
  recharge?: number;      // shield mended per second
  rechargeDelay?: number; // stillness after a break before mending resumes
  // folded in by Engine.spellStats:
  special?: Record<string, number>;
  evolved?: boolean;
}

export interface SpellDef {
  id: string;
  name: string;
  school: string;
  color: string;
  color2: string;
  icon: string;
  desc: string;
  maxLevel: number;
  // most spells strike foes; 'defense' spells only shelter the dreamer, and the
  // tree words their motes (strength / mending / radius / hold) accordingly
  kind?: 'attack' | 'defense';
  stats: (lv: number) => SpellStats;
  levelText: (lv: number) => string;
}

export const SPELLS: Record<string, SpellDef> = {
  ember: {
    id: 'ember', name: 'Emberfall', school: 'Pyromancy',
    color: '#ff8c5a', color2: '#ffd27a', icon: '🜂',
    desc: 'Lob embers that burst into blooms of fire.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.55, 1.35 - lv * 0.13),
      damage: 14 + lv * 7,
      count: 1 + Math.floor(lv / 2),
      radius: 62 + lv * 9,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 ember (${1 + Math.floor(lv / 2)} total), bigger bursts` : 'Faster casts, stronger embers'),
  },
  arcane: {
    id: 'arcane', name: 'Arcane Missiles', school: 'Arcana',
    color: '#b48cff', color2: '#e6d1ff', icon: '🜁',
    desc: 'Homing missiles that chase down the nearest foes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.28, 0.85 - lv * 0.09),
      damage: 9 + lv * 4,
      count: 1 + Math.floor((lv + 1) / 2),
      speed: 420 + lv * 30,
    }),
    levelText: (lv) => (lv % 2 === 1 ? `+1 missile (${1 + Math.floor((lv + 1) / 2)} total)` : 'Faster, harder-hitting missiles'),
  },
  frost: {
    id: 'frost', name: 'Rimeheart', school: 'Cryomancy',
    color: '#8fe8ff', color2: '#e8fbff', icon: '🜄',
    desc: 'A slow orb of condensed cold drifts around you at medium range, damaging and chilling all it grazes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: 0,                                  // continuous — the orb simply orbits
      damage: 15 + lv * 8,                          // heavy per-graze, on a per-foe cooldown
      count: 1 + (lv >= 3 ? 1 : 0),                 // a second orb at level 3 (capped at 2)
      radius: 195 + lv * 13,                        // base orbit range; the orb breathes out to ~+30% and back (AoE fattens the ball, not this)
      speed: 0.95 + lv * 0.08,                      // slow drift (rad/s)
      slow: 0.5 + lv * 0.035,                       // depth of the chill
      slowDur: 1.8 + lv * 0.2,                      // how long the chill clings
    }),
    levelText: (lv) => (lv === 3 ? 'A second orb of cold joins the orbit' : 'A colder, heavier, harder-hitting orb'),
  },
  storm: {
    id: 'storm', name: 'Stormcall', school: 'Tempestry',
    color: '#7ad7ff', color2: '#ffffff', icon: '🜃',
    desc: 'Lightning that arcs from one foe to the next.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.8, 2.1 - lv * 0.2),
      damage: 16 + lv * 8,
      chains: 2 + lv,
      range: 360,
    }),
    levelText: (lv) => `+1 chain (${2 + lv} total), faster casts`,
  },
  void: {
    id: 'void', name: 'Void Rift', school: 'Umbramancy',
    color: '#9a5cff', color2: '#2b1050', icon: '🜏',
    desc: 'Tear a rift that pulls enemies in and burns them.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(4.5, 8 - lv * 0.55),
      dps: 14 + lv * 7,
      radius: 96 + lv * 12,
      pull: 120 + lv * 22,
      duration: 2.6 + lv * 0.3,
    }),
    levelText: () => 'Wider rift, stronger pull, more damage',
  },
  petals: {
    id: 'petals', name: 'Petal Waltz', school: 'Verdancy',
    color: '#7dffb0', color2: '#ffd1ec', icon: '🜍',
    desc: 'Petals orbit you, cutting any foe they touch.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: 0,
      damage: 8 + lv * 5,
      count: 2 + lv,
      radius: 78 + lv * 6,
      speed: 2.4 + lv * 0.28,
    }),
    levelText: (lv) => `+1 petal (${2 + lv} total), faster spin`,
  },
  moon: {
    id: 'moon', name: 'Moonlance', school: 'Lunamancy',
    color: '#fff3b8', color2: '#bcd9ff', icon: '☾',
    desc: 'A lance of moonlight that pierces everything in a line.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.4, 3.2 - lv * 0.3),
      damage: 22 + lv * 12,
      width: 26 + lv * 5,
      length: 460 + lv * 50,
      beams: lv >= 4 ? 2 : 1,
    }),
    levelText: (lv) => (lv === 4 ? 'A second lance, opposite the first' : 'Longer, wider lance'),
  },
  starfall: {
    id: 'starfall', name: 'Starfall', school: 'Cosmology',
    color: '#ffb3f2', color2: '#8a7bff', icon: '✧',
    desc: 'Stars fall from the sky and burst where they land.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.1, 2.6 - lv * 0.22),
      damage: 20 + lv * 10,
      count: 1 + Math.floor(lv / 2),
      radius: 70 + lv * 10,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 star (${1 + Math.floor(lv / 2)} total)` : 'Harder-hitting stars'),
  },
  umbra: {
    id: 'umbra', name: 'Shadowfang', school: 'Umbramancy',
    color: '#8a5cd9', color2: '#20123d', icon: '🜚',
    desc: 'Crescents of shadow that scythe through the horde.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.7, 1.7 - lv * 0.15),
      damage: 13 + lv * 6,
      count: 1 + Math.floor((lv + 1) / 2),
      speed: 380 + lv * 25,
    }),
    levelText: (lv) => (lv % 2 === 1 ? `+1 crescent (${1 + Math.floor((lv + 1) / 2)} total)` : 'Faster, sharper crescents'),
  },
  glaive: {
    id: 'glaive', name: 'Astral Glaive', school: 'Astromancy',
    color: '#9fd8ff', color2: '#e8f6ff', icon: '✵',
    desc: 'A starlight blade flies out and boomerangs back, cutting all it passes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.2, 2.8 - lv * 0.25),
      damage: 15 + lv * 8,
      count: 1 + Math.floor(lv / 3),
      range: 300 + lv * 35,
      speed: 520 + lv * 30,
    }),
    levelText: (lv) => (lv === 3 ? 'A second glaive takes wing' : lv === 6 ? 'A third glaive takes wing' : 'Longer flight, sharper edge'),
  },
  nebula: {
    id: 'nebula', name: 'Nebula Bloom', school: 'Cosmology',
    color: '#c48cff', color2: '#ff9ad5', icon: '❋',
    desc: 'A drifting star-cloud that damages everything inside it.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(5, 9 - lv * 0.6),
      dps: 10 + lv * 6,
      radius: 110 + lv * 16,
      duration: 4 + lv * 0.5,
    }),
    levelText: () => 'Bigger, longer-lasting cloud',
  },
  sigil: {
    id: 'sigil', name: 'Sigil of Sleep', school: 'Oneiromancy',
    color: '#ffd27a', color2: '#b48cff', icon: '✪',
    desc: 'Plant a rune that arms, then bursts for heavy damage; survivors are left asleep.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(2.4, 5 - lv * 0.4),
      damage: 26 + lv * 13,
      radius: 90 + lv * 13,
      sleepDur: 1 + lv * 0.25,
    }),
    levelText: () => 'More damage, longer sleep',
  },
  lantern: {
    id: 'lantern', name: 'Soul Lanterns', school: 'Spiritism',
    color: '#a8ffe8', color2: '#4ad9c4', icon: 'ϟ',
    desc: 'Hang lanterns that pulse, damaging foes beneath them.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(4.2, 7 - lv * 0.45),
      damage: 8 + lv * 4,
      count: 1 + Math.floor(lv / 2),
      radius: 85 + lv * 12,
      duration: 3 + lv * 0.4,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 lantern (${1 + Math.floor(lv / 2)} total)` : 'Brighter, longer-lasting lanterns'),
  },
  nova: {
    id: 'nova', name: 'Twilight Nova', school: 'Duskweaving',
    color: '#ff9ad5', color2: '#5a2a6e', icon: '◈',
    desc: 'A blast of dusk that damages nearby foes and hurls them back.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(2.8, 5.4 - lv * 0.4),
      damage: 18 + lv * 9,
      radius: 140 + lv * 24,
      knock: 260 + lv * 40,
    }),
    levelText: () => 'Wider blast, harder knockback',
  },
  wisps: {
    id: 'wisps', name: 'Wisp Choir', school: 'Spiritism',
    color: '#8cf7e2', color2: '#35c9b8', icon: '⁂',
    desc: 'Wisps trail behind you and dart at foes that come near.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.55, 1.15 - lv * 0.085), // per-wisp dart cadence (~30% quicker)
      damage: 15 + lv * 7.5,                       // ~50% harder darts
      count: 3 + Math.floor(lv / 2),
      range: 510,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 wisp (${3 + Math.floor(lv / 2)} total)` : 'Faster, harder darts'),
  },
  serpent: {
    id: 'serpent', name: 'Dream Serpent', school: 'Thalassomancy',
    color: '#5ad7c9', color2: '#1e4d6e', icon: '∿',
    desc: 'A serpent of water winds through the horde, biting all it passes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(5, 9 - lv * 0.55),
      dps: 26 + lv * 13,
      duration: 4 + lv * 0.4,
      radius: 30 + lv * 5,       // body thickness — thicker with levels
      length: 90 + lv * 26,      // body length — visibly longer with levels
      speed: 250 + lv * 14,
    }),
    levelText: () => 'A longer, thicker, harder-hitting serpent',
  },
  chime: {
    id: 'chime', name: 'Chime of Hours', school: 'Chronomancy',
    color: '#ffd9a0', color2: '#b08a4a', icon: 'Ω',
    desc: 'A clock-hand of sound sweeps a wedge of the field each beat; every fourth beat the whole hour tolls at once.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.55, 2.1 - lv * 0.08), // the beat itself
      damage: 10.5 + lv * 6,
      radius: 108 + lv * 12,
    }),
    levelText: (lv) => (lv === 3 ? 'Faster beat' : 'Wider sweep, harder tolls'),
  },
  eye: {
    id: 'eye', name: 'Sleepless Eye', school: 'Oneiromancy',
    color: '#fff7c9', color2: '#ffb3f2', icon: '☉',
    desc: 'An eye opens above you and sweeps a beam across the field.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(4.4, 7.2 - lv * 0.4),
      damage: 15.6 + lv * 7.8,      // per touch of the gaze
      length: 290 + lv * 32,
      width: 26 + lv * 3,
      duration: 2 + lv * 0.15,      // seconds of sweep
      turns: lv >= 4 ? 1.5 : 1,
    }),
    levelText: (lv) => (lv === 4 ? 'The beam sweeps half a turn farther' : 'Longer, wider beam'),
  },
  brand: {
    id: 'brand', name: 'Nightmare Brand', school: 'Maleficy',
    color: '#ff5a7a', color2: '#3d1020', icon: '⌖',
    desc: 'Brand the toughest foe: it takes damage over time, then bursts when it dies.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(2.6, 4.6 - lv * 0.33),
      dps: 9 + lv * 6,
      damage: 24 + lv * 12, // the death-burst
      duration: 5 + lv * 0.25,
      count: 1 + (lv >= 3 ? 1 : 0) + (lv >= 6 ? 1 : 0),
    }),
    levelText: (lv) => (lv === 3 || lv === 6 ? 'Brand one more foe at once' : 'Heavier damage, bigger burst'),
  },
  ward: {
    id: 'ward', name: 'Somnal Ward', school: 'Aegis',
    color: '#8fb8ff', color2: '#e6f0ff', icon: '⛨',
    desc: 'Glass wards circle you and soak damage; when they shatter, they knock foes back.',
    maxLevel: 6, kind: 'defense',
    stats: (lv) => ({
      cooldown: 0,
      shield: 28 + lv * 13,                            // harm the glass can drink
      recharge: 5 + lv * 1.8,                          // mended per second
      rechargeDelay: Math.max(2.2, 3.8 - lv * 0.24),   // stillness after a break
      radius: 118 + lv * 12,                           // shatter reach
      knock: 240,
    }),
    levelText: (lv) => (lv % 2 === 0 ? 'Tougher glass, wider shatter' : 'Faster recharge, shorter downtime'),
  },
  hush: {
    id: 'hush', name: 'Hush', school: 'Lullaby',
    color: '#b7a7ff', color2: '#e9dcff', icon: '☾',
    desc: 'A quiet aura slows nearby foes, and pulses outward now and then to push them back.',
    maxLevel: 6, kind: 'defense',
    stats: (lv) => ({
      cooldown: 0,
      radius: 116 + lv * 15,
      slow: 0.30 + lv * 0.03,
      slowDur: 0.5,                      // brief but constantly refreshed while inside
      knock: 120 + lv * 16,              // the sigh's push
      interval: Math.max(1.3, 2.3 - lv * 0.14), // seconds between sighs
    }),
    levelText: (lv) => (lv % 2 === 0 ? 'Wider aura, stronger slow' : 'Deeper slow, faster pulses'),
  },
  prism: {
    id: 'prism', name: 'Kaleidoscope', school: 'Chromamancy',
    color: '#f4c9ff', color2: '#9fffe0', icon: '◭',
    desc: 'Hang a prism that fires rays at nearby foes until it fades.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(5, 8.2 - lv * 0.55),
      damage: 11 + lv * 6,
      duration: 4.2 + lv * 0.4,
      interval: Math.max(0.35, 0.6 - lv * 0.04),
      range: 420,
      count: 1 + (lv >= 6 ? 1 : 0),
    }),
    levelText: (lv) => (lv === 6 ? 'A second prism takes the air' : 'Faster, brighter rays'),
  },
};

// evolutions: unlocked by raising a spell to max level, then choosing its
// transcendent form on a later level-up
export const EVOLVE: Record<string, { name: string; desc: string }> = {
  ember: { name: 'Pyre Bloom', desc: 'Bursts leave fire burning on the ground.' },
  arcane: { name: 'Arcane Torrent', desc: 'On impact, missiles split into homing shards.' },
  frost: { name: 'Winterloom', desc: 'The orbs crystallize and loose ice shards at nearby foes.' },
  storm: { name: 'Skyfracture', desc: 'Lightning leaps 3 more times and barely weakens.' },
  void: { name: 'Event Horizon', desc: 'When the rift closes, it collapses in a damaging burst.' },
  petals: { name: 'Wild Garden', desc: 'A second ring of petals spins the opposite way.' },
  moon: { name: 'Eclipsing Lance', desc: 'Lances sweep sideways across the field as they burn.' },
  starfall: { name: 'Cosmic Ruin', desc: 'Fallen stars leave burning pools of starlight.' },
  umbra: { name: 'Night’s Teeth', desc: '+2 crescents, each striking 50% harder.' },
  glaive: { name: 'Star Sovereign', desc: 'Returning glaives burst into damaging stardust.' },
  nebula: { name: 'Genesis Cloud', desc: 'The cloud grows huge and follows you.' },
  sigil: { name: 'The Great Seal', desc: 'The rune detonates twice.' },
  lantern: { name: 'Lantern Procession', desc: 'Lanterns last far longer and pulse twice as fast.' },
  nova: { name: 'Endless Dusk', desc: 'Each blast is followed by a second wave.' },
  wisps: { name: 'Choir Eternal', desc: 'Every 8th dart, the whole choir strikes one foe at once.' },
  serpent: { name: 'Leviathan of Sleep', desc: 'The serpent grows with every kill, up to twice its size and damage.' },
  chime: { name: 'The Last Hour', desc: 'Every crescendo freezes all foes in the ring for a moment.' },
  eye: { name: 'Aurora Crown', desc: 'A second beam sweeps the other way, and the light lingers on the ground.' },
  brand: { name: 'The Devouring Name', desc: 'When a branded foe dies, the brand jumps to 3 nearby foes.' },
  prism: { name: 'The Unblinking Prism', desc: 'Rays split through their first target into two more.' },
  ward: { name: 'Looking-Glass Aegis', desc: 'Wards recharge twice as fast; each shatter reflects enemy shots and briefly shields you from all harm.' },
  hush: { name: 'Deep Hush', desc: 'The slow deepens almost to a full stop, and you heal while standing in your aura.' },
};

// `per` is the percentage each rank grants — the level-up card uses it to show
// the running "(X% total)". Boons without it (swift, regen) don't display one.
export interface BoonDef { id: string; name: string; icon: string; desc: string; max: number; per?: number }

export const BOONS: Record<string, BoonDef> = {
  power: { id: 'power', name: 'Lucid Focus', icon: '✦', desc: '12% more spell damage.', max: 5, per: 12 },
  haste: { id: 'haste', name: 'Quickened Reverie', icon: '≋', desc: '10% more spell haste.', max: 5, per: 10 },
  vitality: { id: 'vitality', name: 'Heartbloom', icon: '❤', desc: '10% more maximum life.', max: 5, per: 10 },
  swift: { id: 'swift', name: 'Zephyr Step', icon: '➳', desc: 'Move 8% faster.', max: 4 },
  magnet: { id: 'magnet', name: 'Dream Lure', icon: '◉', desc: '40% more pickup area.', max: 4, per: 40 },
  regen: { id: 'regen', name: 'Moonmilk', icon: '☽', desc: 'Regenerate 1 life every 2 seconds.', max: 3 },
  aoe: { id: 'aoe', name: 'Expanding Reverie', icon: '◎', desc: '10% more area of effect.', per: 10, max: 3 },
};

export const GENERIC: Record<string, BoonDef> = {
  power: { id: 'power', name: 'Arcane Amplification', icon: '✴', desc: '12% more spell damage.', max: Infinity },
  vital: { id: 'vital', name: 'Dream Fortitude', icon: '⬡', desc: '10% more maximum life.', max: Infinity },
};
