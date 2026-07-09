// Fourteen schools of magic. Each spell keeps a unique identity in color,
// motion, sound and particle language. Cast logic lives in the engine.

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
  stats: (lv: number) => SpellStats;
  levelText: (lv: number) => string;
}

export const SPELLS: Record<string, SpellDef> = {
  ember: {
    id: 'ember', name: 'Emberfall', school: 'Pyromancy',
    color: '#ff8c5a', color2: '#ffd27a', icon: '🜂',
    desc: 'Lob dreaming embers that burst into blossoms of flame.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.55, 1.35 - lv * 0.13),
      damage: 14 + lv * 7,
      count: 1 + Math.floor(lv / 2),
      radius: 62 + lv * 9,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 ember (${1 + Math.floor(lv / 2)} total), hotter blossoms` : 'Faster casting, bigger blossoms'),
  },
  arcane: {
    id: 'arcane', name: 'Arcane Missiles', school: 'Arcana',
    color: '#b48cff', color2: '#e6d1ff', icon: '🜁',
    desc: 'Violet seekers spiral through the dream toward your foes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.28, 0.85 - lv * 0.09),
      damage: 9 + lv * 4,
      count: 1 + Math.floor((lv + 1) / 2),
      speed: 420 + lv * 30,
    }),
    levelText: (lv) => (lv % 2 === 1 ? `+1 missile (${1 + Math.floor((lv + 1) / 2)} total), sharper hunger` : 'Faster, harder-hitting missiles'),
  },
  frost: {
    id: 'frost', name: 'Frostbloom', school: 'Cryomancy',
    color: '#8fe8ff', color2: '#e8fbff', icon: '🜄',
    desc: 'A ring of winter unfolds from you, slowing all it kisses.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(2.2, 4.4 - lv * 0.35),
      damage: 12 + lv * 6,
      radius: 130 + lv * 22,
      slow: 0.45 + lv * 0.04,
      slowDur: 1.6 + lv * 0.25,
    }),
    levelText: () => 'Wider bloom, deeper cold',
  },
  storm: {
    id: 'storm', name: 'Stormcall', school: 'Tempestry',
    color: '#7ad7ff', color2: '#ffffff', icon: '🜃',
    desc: 'Sky-veins of lightning leap from foe to foe.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.8, 2.1 - lv * 0.2),
      damage: 16 + lv * 8,
      chains: 2 + lv,
      range: 360,
    }),
    levelText: (lv) => `+1 chain (${2 + lv} total), quicker thunder`,
  },
  void: {
    id: 'void', name: 'Void Rift', school: 'Umbramancy',
    color: '#9a5cff', color2: '#2b1050', icon: '🜏',
    desc: 'Tear a hungry wound in the dream that drinks your enemies in.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(4.5, 8 - lv * 0.55),
      dps: 14 + lv * 7,
      radius: 96 + lv * 12,
      pull: 120 + lv * 22,
      duration: 2.6 + lv * 0.3,
    }),
    levelText: () => 'Hungrier, wider, longer-lived',
  },
  petals: {
    id: 'petals', name: 'Petal Waltz', school: 'Verdancy',
    color: '#7dffb0', color2: '#ffd1ec', icon: '🜍',
    desc: 'Spirit petals orbit you in a razor-sweet waltz.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: 0,
      damage: 8 + lv * 5,
      count: 2 + lv,
      radius: 78 + lv * 6,
      speed: 2.4 + lv * 0.28,
    }),
    levelText: (lv) => `+1 petal (${2 + lv} total), faster waltz`,
  },
  moon: {
    id: 'moon', name: 'Moonlance', school: 'Lunamancy',
    color: '#fff3b8', color2: '#bcd9ff', icon: '☾',
    desc: 'A lance of condensed moonlight pierces the horde.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.4, 3.2 - lv * 0.3),
      damage: 22 + lv * 12,
      width: 26 + lv * 5,
      length: 460 + lv * 50,
      beams: lv >= 4 ? 2 : 1,
    }),
    levelText: (lv) => (lv === 4 ? 'A second lance, opposite the first' : 'Brighter, broader light'),
  },
  starfall: {
    id: 'starfall', name: 'Starfall', school: 'Cosmology',
    color: '#ffb3f2', color2: '#8a7bff', icon: '✧',
    desc: 'Call sleeping stars down from the firmament to burst upon your foes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.1, 2.6 - lv * 0.22),
      damage: 20 + lv * 10,
      count: 1 + Math.floor(lv / 2),
      radius: 70 + lv * 10,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 falling star (${1 + Math.floor(lv / 2)} total)` : 'Heavier, brighter impacts'),
  },
  umbra: {
    id: 'umbra', name: 'Shadowfang', school: 'Umbramancy',
    color: '#8a5cd9', color2: '#20123d', icon: '🜚',
    desc: 'Crescents of living shadow scythe through everything in their path.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(0.7, 1.7 - lv * 0.15),
      damage: 13 + lv * 6,
      count: 1 + Math.floor((lv + 1) / 2),
      speed: 380 + lv * 25,
    }),
    levelText: (lv) => (lv % 2 === 1 ? `+1 fang (${1 + Math.floor((lv + 1) / 2)} total), deeper shadow` : 'Faster, crueller crescents'),
  },
  glaive: {
    id: 'glaive', name: 'Astral Glaive', school: 'Astromancy',
    color: '#9fd8ff', color2: '#e8f6ff', icon: '✵',
    desc: 'A blade of starlight sails out and returns, reaping as it goes.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(1.2, 2.8 - lv * 0.25),
      damage: 15 + lv * 8,
      count: 1 + Math.floor(lv / 3),
      range: 300 + lv * 35,
      speed: 520 + lv * 30,
    }),
    levelText: (lv) => (lv === 3 ? 'A second glaive takes wing' : lv === 6 ? 'A third glaive takes wing' : 'Farther flight, keener edge'),
  },
  nebula: {
    id: 'nebula', name: 'Nebula Bloom', school: 'Cosmology',
    color: '#c48cff', color2: '#ff9ad5', icon: '❋',
    desc: 'A drifting cloud of newborn stars smothers all who wander inside.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(5, 9 - lv * 0.6),
      dps: 10 + lv * 6,
      radius: 110 + lv * 16,
      duration: 4 + lv * 0.5,
    }),
    levelText: () => 'Vaster, denser stellar mist',
  },
  sigil: {
    id: 'sigil', name: 'Sigil of Sleep', school: 'Oneiromancy',
    color: '#ffd27a', color2: '#b48cff', icon: '✪',
    desc: 'Inscribe a drowsy rune that detonates, lulling survivors to stillness.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(2.4, 5 - lv * 0.4),
      damage: 26 + lv * 13,
      radius: 90 + lv * 13,
      sleepDur: 1 + lv * 0.25,
    }),
    levelText: () => 'Louder waking, longer sleep',
  },
  lantern: {
    id: 'lantern', name: 'Soul Lanterns', school: 'Spiritism',
    color: '#a8ffe8', color2: '#4ad9c4', icon: 'ϟ',
    desc: 'Hang ghost-lanterns over the horde that pulse with cold green fire.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(4.2, 7 - lv * 0.45),
      damage: 8 + lv * 4,
      count: 1 + Math.floor(lv / 2),
      radius: 85 + lv * 12,
      duration: 3 + lv * 0.4,
    }),
    levelText: (lv) => (lv % 2 === 0 ? `+1 lantern (${1 + Math.floor(lv / 2)} total)` : 'Brighter, longer-burning lanterns'),
  },
  nova: {
    id: 'nova', name: 'Twilight Nova', school: 'Duskweaving',
    color: '#ff9ad5', color2: '#5a2a6e', icon: '◈',
    desc: 'Dusk erupts outward from you, hurling the horde back into the dark.',
    maxLevel: 6,
    stats: (lv) => ({
      cooldown: Math.max(2.8, 5.4 - lv * 0.4),
      damage: 18 + lv * 9,
      radius: 140 + lv * 24,
      knock: 260 + lv * 40,
    }),
    levelText: () => 'Wider dusk, harder throw',
  },
};

// evolutions: unlocked by raising a spell to max level, then choosing its
// transcendent form on a later level-up
export const EVOLVE: Record<string, { name: string; desc: string }> = {
  ember: { name: 'Pyre Bloom', desc: 'Embers scorch the ground where they burst.' },
  arcane: { name: 'Arcane Torrent', desc: 'Missiles splinter into seeking shards on impact.' },
  frost: { name: 'Absolute Winter', desc: 'The bloom freezes foes solid where they stand.' },
  storm: { name: 'Skyfracture', desc: 'Thunder leaps three chains farther, barely fading.' },
  void: { name: 'Event Horizon', desc: 'The rift collapses in a hungry burst when it closes.' },
  petals: { name: 'Wild Garden', desc: 'A second ring of petals waltzes against the first.' },
  moon: { name: 'Eclipsing Lance', desc: 'Lances sweep across the field as they burn.' },
  starfall: { name: 'Cosmic Ruin', desc: 'Fallen stars leave pools of burning starlight.' },
  umbra: { name: 'Night’s Teeth', desc: 'Two more fangs, striking half again as hard.' },
  glaive: { name: 'Star Sovereign', desc: 'Glaives burst into stardust as they return to you.' },
  nebula: { name: 'Genesis Cloud', desc: 'The nebula grows vast and follows its maker.' },
  sigil: { name: 'The Great Seal', desc: 'The rune sounds twice.' },
  lantern: { name: 'Lantern Procession', desc: 'Lanterns burn far longer and pulse twice as fast.' },
  nova: { name: 'Endless Dusk', desc: 'Each nova echoes a second wave.' },
};

export interface BoonDef { id: string; name: string; icon: string; desc: string; max: number }

export const BOONS: Record<string, BoonDef> = {
  power: { id: 'power', name: 'Lucid Focus', icon: '✦', desc: 'Your will sharpens — spells strike 12% harder.', max: 5 },
  haste: { id: 'haste', name: 'Quickened Reverie', icon: '≋', desc: 'The dream hurries — spells cast 10% faster (diminishing).', max: 5 },
  vitality: { id: 'vitality', name: 'Heartbloom', icon: '❤', desc: '+25 max life, and 25 life blooms back at once.', max: 5 },
  swift: { id: 'swift', name: 'Zephyr Step', icon: '➳', desc: 'The wind carries you 10% faster.', max: 4 },
  magnet: { id: 'magnet', name: 'Dream Lure', icon: '◉', desc: 'Essence drifts to you from 45% farther away.', max: 4 },
  regen: { id: 'regen', name: 'Moonmilk', icon: '☽', desc: 'Mend 1 life every 2 seconds.', max: 3 },
};

export const GENERIC: Record<string, BoonDef> = {
  power: { id: 'power', name: 'Arcane Amplification', icon: '✴', desc: 'Every spell you hold strikes 10% harder.', max: Infinity },
  aoe: { id: 'aoe', name: 'Expanding Reverie', icon: '◎', desc: 'Every area of effect widens by 10%.', max: Infinity },
  vital: { id: 'vital', name: 'Dream Fortitude', icon: '⬡', desc: '+15 max life, and 15 life restored now.', max: Infinity },
};
