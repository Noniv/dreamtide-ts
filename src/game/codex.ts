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
  seen: number;  // `found` at the last time the book was opened
}

function fresh(): CodexData {
  return {
    spells: {}, evolved: {}, boons: {}, generics: {}, relics: {}, pacts: {}, reactions: {},
    found: 0, seen: 0,
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
        seen: d.seen || 0,
      };
    }
  } catch { /* corrupted store — start fresh */ }
  return fresh();
}

class Codex {
  data: CodexData = load();

  private save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  // Each of these records a discovery and returns whether it was brand new, so
  // callers could sing a note the first time (unused for now — silent).
  private mark(set: Record<string, true>, id: string): boolean {
    if (set[id]) return false;
    set[id] = true;
    this.data.found++;
    this.save();
    return true;
  }

  discoverSpell(id: string, level: number): boolean {
    const cur = this.data.spells[id] || 0;
    if (level <= cur) return false;
    this.data.spells[id] = level;
    this.data.found++;
    this.save();
    return true;
  }
  discoverEvolution(id: string): boolean { return this.mark(this.data.evolved, id); }
  discoverBoon(id: string): boolean { return this.mark(this.data.boons, id); }
  discoverGeneric(id: string): boolean { return this.mark(this.data.generics, id); }
  discoverRelic(id: string): boolean { return this.mark(this.data.relics, id); }
  discoverPact(id: string): boolean { return this.mark(this.data.pacts, id); }
  discoverReaction(id: string): boolean { return this.mark(this.data.reactions, id); }

  // ---- reads for the book UI
  spellLevel(id: string): number { return this.data.spells[id] || 0; }
  knowsSpell(id: string): boolean { return (this.data.spells[id] || 0) > 0; }
  knowsEvolution(id: string): boolean { return !!this.data.evolved[id]; }
  knowsBoon(id: string): boolean { return !!this.data.boons[id]; }
  knowsGeneric(id: string): boolean { return !!this.data.generics[id]; }
  knowsRelic(id: string): boolean { return !!this.data.relics[id]; }
  knowsPact(id: string): boolean { return !!this.data.pacts[id]; }
  knowsReaction(id: string): boolean { return !!this.data.reactions[id]; }

  // undiscovered facts since the book was last opened — drives the menu glow
  unseen(): number { return Math.max(0, this.data.found - this.data.seen); }
  markSeen() {
    if (this.data.seen === this.data.found) return;
    this.data.seen = this.data.found;
    this.save();
  }
}

export const codex = new Codex();
