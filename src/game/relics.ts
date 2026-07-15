// Relics and pacts: the run-defining rewards of the redesigned dream.
//
// · Elements tag every point of damage. Elements leave marks on enemies and
//   marks react with other elements — the Resonance system (see engine).
// · Relics are one-of-a-kind legendary modifiers offered 1-of-3 when a boss
//   falls. Each one bends a whole run around itself.
// · Pacts are the Whispering Altars' bargains: a boon braided to a curse,
//   accepted or refused mid-run.

export type Element =
  | 'arcane' | 'fire' | 'frost' | 'storm'
  | 'light' | 'shadow' | 'nature' | 'cosmic';

// how each element presents itself in the UI (cards, tooltips, the Dream Book)
export const ELEMENTS: Record<Element, { name: string; icon: string; color: string }> = {
  arcane: { name: 'Arcane', icon: '✦', color: '#b48cff' },
  fire: { name: 'Fire', icon: '🜂', color: '#ff8c5a' },
  frost: { name: 'Frost', icon: '❆', color: '#8fe8ff' },
  storm: { name: 'Storm', icon: 'ϟ', color: '#7ad7ff' },
  light: { name: 'Light', icon: '✧', color: '#fff3b8' },
  shadow: { name: 'Shadow', icon: '☽', color: '#9a5cff' },
  nature: { name: 'Nature', icon: '❀', color: '#7dffb0' },
  cosmic: { name: 'Cosmic', icon: '✵', color: '#ffb3f2' },
};

export interface RelicDef {
  id: string;
  name: string;
  icon: string;
  color: string;
  desc: string;
}

export const RELICS: Record<string, RelicDef> = {
  cinderheart: {
    id: 'cinderheart', name: 'Cinderheart', icon: '✹', color: '#ff8c5a',
    desc: 'Your explosions leave the ground burning where they land.',
  },
  frozentear: {
    id: 'frozentear', name: 'Frozen Tear', icon: '❆', color: '#8fe8ff',
    desc: 'When you take damage, a frost blast erupts from you (every 6s at most).',
  },
  stormcrown: {
    id: 'stormcrown', name: 'Stormcrown', icon: '☈', color: '#7ad7ff',
    desc: 'Every 5th spell you cast also strikes the nearest foe with a bolt.',
  },
  hourglass: {
    id: 'hourglass', name: 'Hourglass of the Deep', icon: '⧗', color: '#7dffb0',
    desc: 'Killing an elite triggers every surge at once for 4 seconds.',
  },
  thornedhalo: {
    id: 'thornedhalo', name: 'Thorned Halo', icon: '✥', color: '#fff3b8',
    desc: 'Foes that damage you are branded — branded foes take 12% more damage from everything.',
  },
  moonsickle: {
    id: 'moonsickle', name: 'Moonlit Sickle', icon: '☾', color: '#fff3b8',
    desc: 'Your critical strikes brand foes — branded foes take 12% more damage from everything.',
  },
  anchor: {
    id: 'anchor', name: 'Dream Anchor', icon: '⚓', color: '#9fd8ff',
    desc: 'Hold still: after a moment without moving, your spells deal 25% more damage.',
  },
  cometring: {
    id: 'cometring', name: 'Ring of the Comet', icon: '☄', color: '#ffb3f2',
    desc: 'Every 12 seconds, a comet falls on the thickest part of the horde.',
  },
  chalice: {
    id: 'chalice', name: 'Night Chalice', icon: '⚗', color: '#7dffb0',
    desc: 'Enemies that die near you heal you a little.',
  },
  prismheart: {
    id: 'prismheart', name: 'Prism Heart', icon: '◬', color: '#e6d1ff',
    desc: 'Your elemental marks last twice as long, and resonance bursts deal 50% more damage.',
  },
  cartographer: {
    id: 'cartographer', name: 'Cartographer’s Dream', icon: '✯', color: '#ffd27a',
    desc: 'Golden wisps, whispering altars and fallen stars seek you out far more often.',
  },
  sovereign: {
    id: 'sovereign', name: 'Sovereign’s Pact', icon: '♛', color: '#ff9ad5',
    desc: 'Your spells deal 35% more damage — but you lose a fifth of your max life for the rest of the dream.',
  },
};

export const RELIC_IDS = Object.keys(RELICS);

// ---------------------------------------------------------------- pacts
// Every fx key the engine folds in. Boons are player-side; curse* keys feed
// the difficulty computation.
export interface PactFx {
  dmg?: number; aoe?: number; haste?: number; xp?: number; regen?: number;
  hp?: number; healFull?: number;
  curseSpd?: number; curseDmg?: number; curseHp?: number;
  curseFloor?: number; curseElite?: number;
}

export interface PactDef {
  id: string;
  name: string;
  icon: string;
  boon: string;
  curse: string;
  fx: PactFx;
}

export const PACTS: PactDef[] = [
  {
    id: 'embers', name: 'Pact of Embers', icon: '🜂',
    boon: 'Your spells deal 18% more damage',
    curse: 'the horde moves 12% faster',
    fx: { dmg: 18, curseSpd: 12 },
  },
  {
    id: 'deep', name: 'Pact of the Deep', icon: '🜄',
    boon: 'Every area of effect grows 25% larger',
    curse: '12 more enemies swarm you at all times',
    fx: { aoe: 25, curseFloor: 12 },
  },
  {
    id: 'haste', name: 'Pact of the Rushing Hour', icon: '≋',
    boon: 'Your spells cast 15% faster',
    curse: 'enemies strike 18% harder',
    fx: { haste: 15, curseDmg: 18 },
  },
  {
    id: 'blood', name: 'Pact of Blood', icon: '❤',
    boon: 'Heal to full, and +40 max life',
    curse: 'enemies gain 22% more life',
    fx: { hp: 40, healFull: 1, curseHp: 22 },
  },
  {
    id: 'greed', name: 'Pact of Greed', icon: '❂',
    boon: 'Gain 35% more essence',
    curse: 'elites stir 35% more often',
    fx: { xp: 35, curseElite: 35 },
  },
  {
    id: 'stillness', name: 'Pact of Stillness', icon: '☽',
    boon: 'Regenerate 2 more life every 2 seconds',
    curse: 'the horde moves 10% faster and hits 10% harder',
    fx: { regen: 2, curseSpd: 10, curseDmg: 10 },
  },
];
