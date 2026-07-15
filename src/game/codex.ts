// The Dream Book: a persistent codex of what the dreamer has learned. Every
// spell, level, evolution, boon, relic, altar pact and resonance interaction
// stays sealed until the player meets it in a dream, then unlocks for good.
//
// The book UI enumerates the live content tables (SPELLS, BOONS, RELICS, PACTS,
// REACTIONS), so any new content added there becomes a book entry automatically
// — this module only remembers *what was discovered*, never the catalogue.
//
// Persisted to localStorage under its own key, written the instant a discovery
// happens mid-run so nothing is lost if the run is abandoned.

const STORE_KEY = 'dreamtide_codex_v1';

// ---------------------------------------------------------------- reactions
// The Resonance interactions the engine can bloom off an enemy. This table is
// the single source of truth for the book; the engine records a discovery by
// id as each one first fires (see damageEnemy / killEnemy).
export interface ReactionDef {
  id: string;
  name: string;
  icon: string;
  color: string;
  recipe: string; // the two effects that combine
  desc: string;
}

export const REACTIONS: Record<string, ReactionDef> = {
  shatter: {
    id: 'shatter', name: 'Shatter', icon: '❆', color: '#bff1ff',
    recipe: 'Fire strikes a chilled foe',
    desc: 'An icy burst damages and chills nearby foes.',
  },
  eclipse: {
    id: 'eclipse', name: 'Eclipse', icon: '☾', color: '#c9a4ff',
    recipe: 'Shadow strikes a light-branded foe',
    desc: 'A burst of dark damages nearby foes.',
  },
  discharge: {
    id: 'discharge', name: 'Discharge', icon: 'ϟ', color: '#bfeaff',
    recipe: 'A storm-charged foe dies',
    desc: 'Lightning leaps to nearby foes; their deaths can chain it onward.',
  },
  overgrow: {
    id: 'overgrow', name: 'Overgrowth', icon: '❀', color: '#7dffb0',
    recipe: 'Frost strikes a spore-marked foe',
    desc: 'Frozen brambles burst out, damaging and deeply chilling nearby foes.',
  },
  unravel: {
    id: 'unravel', name: 'Unravel', icon: '✦', color: '#b48cff',
    recipe: 'Arcane strikes a foe bearing any mark',
    desc: 'The marks resonate — a burst of raw magic, stronger for each mark carried.',
  },
};

// ---------------------------------------------------------------- storage
interface CodexData {
  spells: Record<string, number>;      // spell id → highest level witnessed
  evolved: Record<string, true>;       // spell id → its evolution seen
  boons: Record<string, true>;
  generics: Record<string, true>;
  relics: Record<string, true>;
  pacts: Record<string, true>;
  reactions: Record<string, true>;
  found: number; // running tally of distinct discoveries ever made
  // entries updated since they were last scrolled into view in the book,
  // keyed `${kind}:${id}` — drives the menu / tab / entry NEW badges
  unseen: Record<string, true>;
}

function fresh(): CodexData {
  return {
    spells: {}, evolved: {}, boons: {}, generics: {}, relics: {}, pacts: {}, reactions: {},
    found: 0, unseen: {},
  };
}

function load(): CodexData {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const base = fresh();
      return {
        spells: d.spells || base.spells,
        evolved: d.evolved || base.evolved,
        boons: d.boons || base.boons,
        generics: d.generics || base.generics,
        relics: d.relics || base.relics,
        pacts: d.pacts || base.pacts,
        reactions: d.reactions || base.reactions,
        found: d.found || 0,
        unseen: d.unseen || {},
      };
    }
  } catch { /* corrupted store — start fresh */ }
  return fresh();
}

// something new was written into the book mid-run — the UI raises a toast.
// `level` rides along on spell discoveries (1 = the spell itself; higher =
// a new deepest level witnessed).
export type DiscoveryKind = 'spell' | 'evolution' | 'boon' | 'generic' | 'relic' | 'pact' | 'reaction';
export interface Discovery { kind: DiscoveryKind; id: string; level?: number }
type DiscoveryListener = (d: Discovery) => void;

class Codex {
  data: CodexData = load();
  private listeners = new Set<DiscoveryListener>();

  // subscribe to brand-new discoveries; returns the unsubscribe
  onDiscover(fn: DiscoveryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(kind: DiscoveryKind, id: string, level?: number) {
    for (const fn of this.listeners) fn({ kind, id, level });
  }

  private save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  // Each of these records a discovery and returns whether it was brand new;
  // brand-new ones are announced to the listeners (the on-screen toast) and
  // flagged unseen until their book entry is scrolled into view.
  private mark(set: Record<string, true>, kind: DiscoveryKind, id: string): boolean {
    if (set[id]) return false;
    set[id] = true;
    this.data.found++;
    this.data.unseen[`${kind}:${id}`] = true;
    this.save();
    this.notify(kind, id);
    return true;
  }

  discoverSpell(id: string, level: number): boolean {
    const cur = this.data.spells[id] || 0;
    if (level <= cur) return false;
    this.data.spells[id] = level;
    this.data.found++;
    this.data.unseen[`spell:${id}`] = true;
    this.save();
    this.notify('spell', id, level);
    return true;
  }
  discoverEvolution(id: string): boolean { return this.mark(this.data.evolved, 'evolution', id); }
  discoverBoon(id: string): boolean { return this.mark(this.data.boons, 'boon', id); }
  discoverGeneric(id: string): boolean { return this.mark(this.data.generics, 'generic', id); }
  discoverRelic(id: string): boolean { return this.mark(this.data.relics, 'relic', id); }
  discoverPact(id: string): boolean { return this.mark(this.data.pacts, 'pact', id); }
  discoverReaction(id: string): boolean { return this.mark(this.data.reactions, 'reaction', id); }

  // ---- reads for the book UI
  spellLevel(id: string): number { return this.data.spells[id] || 0; }
  knowsSpell(id: string): boolean { return (this.data.spells[id] || 0) > 0; }
  knowsEvolution(id: string): boolean { return !!this.data.evolved[id]; }
  knowsBoon(id: string): boolean { return !!this.data.boons[id]; }
  knowsGeneric(id: string): boolean { return !!this.data.generics[id]; }
  knowsRelic(id: string): boolean { return !!this.data.relics[id]; }
  knowsPact(id: string): boolean { return !!this.data.pacts[id]; }
  knowsReaction(id: string): boolean { return !!this.data.reactions[id]; }

  // ---- the NEW badges: entries not yet scrolled into view in the book
  unseen(): number { return Object.keys(this.data.unseen).length; }
  unseenKeys(): string[] { return Object.keys(this.data.unseen); }
  unseenEntry(kind: DiscoveryKind, id: string): boolean { return !!this.data.unseen[`${kind}:${id}`]; }
  markEntrySeen(kind: DiscoveryKind, id: string) {
    const key = `${kind}:${id}`;
    if (!this.data.unseen[key]) return;
    delete this.data.unseen[key];
    this.save();
  }
}

export const codex = new Codex();
