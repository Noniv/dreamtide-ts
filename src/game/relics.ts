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
    desc: 'Every explosion you cause leaves the ground burning where it bloomed.',
  },
  frozentear: {
    id: 'frozentear', name: 'Frozen Tear', icon: '❆', color: '#8fe8ff',
    desc: 'When you are struck, winter answers — a frost bloom erupts from you. (6s rest)',
  },
  stormcrown: {
    id: 'stormcrown', name: 'Stormcrown', icon: '☈', color: '#7ad7ff',
    desc: 'Every fifth spell you cast calls a charged bolt down on the nearest foe.',
  },
  hourglass: {
    id: 'hourglass', name: 'Hourglass of the Deep', icon: '⧗', color: '#7dffb0',
    desc: 'Slaying an elite floods you with every surge at once for 4 seconds.',
  },
  thornedhalo: {
    id: 'thornedhalo', name: 'Thorned Halo', icon: '✥', color: '#fff3b8',
    desc: 'Every foe that wounds you is branded with vengeful moonlight — branded foes take more from everything.',
  },
  moonsickle: {
    id: 'moonsickle', name: 'Moonlit Sickle', icon: '☾', color: '#fff3b8',
    desc: 'Your critical strikes brand foes with moonlight — branded foes take more from everything.',
  },
  anchor: {
    id: 'anchor', name: 'Dream Anchor', icon: '⚓', color: '#9fd8ff',
    desc: 'Stand your ground: after a moment of stillness your spells strike 25% harder.',
  },
  cometring: {
    id: 'cometring', name: 'Ring of the Comet', icon: '☄', color: '#ffb3f2',
    desc: 'Every 12 seconds a comet falls upon the thickest of the horde, unbidden.',
  },
  chalice: {
    id: 'chalice', name: 'Night Chalice', icon: '⚗', color: '#7dffb0',
    desc: 'Foes that die near you spill a drop of life back into you.',
  },
  prismheart: {
    id: 'prismheart', name: 'Prism Heart', icon: '◬', color: '#e6d1ff',
    desc: 'Your marks cling twice as long, and every resonance reaction strikes half again as hard.',
  },
  cartographer: {
    id: 'cartographer', name: 'Cartographer’s Dream', icon: '✯', color: '#ffd27a',
    desc: 'Fallen stars, whispering altars and golden wisps all find their way to you far more often.',
  },
  sovereign: {
    id: 'sovereign', name: 'Sovereign’s Pact', icon: '♛', color: '#ff9ad5',
    desc: 'Your spells strike 35% harder — but a fifth of your life is the price, paid now and forever.',
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
    boon: 'Your spells strike 18% harder',
    curse: 'the horde moves 12% faster',
    fx: { dmg: 18, curseSpd: 12 },
  },
  {
    id: 'deep', name: 'Pact of the Deep', icon: '🜄',
    boon: 'Every area of effect widens by 25%',
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
    boon: 'Your wounds close and your heart grows by 40 life',
    curse: 'enemies gain 22% more life',
    fx: { hp: 40, healFull: 1, curseHp: 22 },
  },
  {
    id: 'greed', name: 'Pact of Greed', icon: '❂',
    boon: 'You glean 35% more essence',
    curse: 'elites stir 35% more often',
    fx: { xp: 35, curseElite: 35 },
  },
  {
    id: 'stillness', name: 'Pact of Stillness', icon: '☽',
    boon: 'Mend 2 more life every 2 seconds',
    curse: 'the horde moves 10% faster and hits 10% harder',
    fx: { regen: 2, curseSpd: 10, curseDmg: 10 },
  },
];
