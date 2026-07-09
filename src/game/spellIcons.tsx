// Inline SVG spell icons. The alchemical Unicode glyphs originally used (🜁🜂🜄…)
// live in a Unicode block with almost no cross-platform font coverage, so they
// vanished on Linux. These hand-drawn SVGs render identically everywhere and
// inherit the spell colour via `currentColor`.
//
// Each entry is the inner markup of a 24×24 viewBox, stroked with currentColor.
import React from 'react';

const P: Record<string, React.ReactNode> = {
  // Arcane Missiles — a four-pointed seeker star with a small centre dot that
  // sits clear of the arms (inner vertices pulled out so the points aren't needles)
  arcane: (
    <>
      <path d="M12 2.5 L14.1 9.9 L21.5 12 L14.1 14.1 L12 21.5 L9.9 14.1 L2.5 12 L9.9 9.9 Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  // Emberfall — a rounded but slim flame with an inner curl
  ember: (
    <>
      <path d="M12 2.5 C12.6 6 16.5 8.5 16.5 13.5 a4.5 4.5 0 0 1-9 0 C7.5 10.5 9 9.5 9.8 7.5 C10.2 9 11 9.6 12 10 C13 9.2 12.6 5 12 2.5 Z" strokeLinejoin="round" />
    </>
  ),
  // Frostbloom — six-armed snowflake; each arm tip splits into two prongs that
  // open OUTWARD (away from the centre)
  frost: (
    <>
      {/* three main axes through the centre */}
      <path d="M12 2.5 V21.5 M3.77 7.25 L20.23 16.75 M20.23 7.25 L3.77 16.75" />
      {/* dendrite branches: each pair springs directly off the main arm line and
          angles outward+forward (no detached Y at the tip) */}
      <path d="M12.0 5.8 L9.5 3.8 M12.0 5.8 L14.5 3.8" />
      <path d="M17.4 8.9 L17.8 5.7 M17.4 8.9 L20.3 10.1" />
      <path d="M17.4 15.1 L20.3 13.9 M17.4 15.1 L17.8 18.3" />
      <path d="M12.0 18.2 L14.5 20.2 M12.0 18.2 L9.5 20.2" />
      <path d="M6.6 15.1 L6.2 18.3 M6.6 15.1 L3.7 13.9" />
      <path d="M6.6 8.9 L3.7 10.1 M6.6 8.9 L6.2 5.7" />
    </>
  ),
  // Stormcall — a lightning bolt that tapers to a point at BOTH ends
  storm: <path d="M14.5 1.5 L5 12.5 L10.5 12.5 L9 22.5 L19 10.5 L13.5 10.5 Z" strokeLinejoin="round" />,
  // Void Rift — a true Archimedean spiral collapsing to the centre (sampled as a
  // polyline; arc-command spirals don't render as an actual spiral)
  void: <path d="M12.0 12.0 L12.2 12.1 L12.3 12.2 L12.3 12.5 L12.2 12.8 L11.9 13.0 L11.5 13.0 L11.0 12.9 L10.6 12.6 L10.3 12.1 L10.1 11.5 L10.3 10.8 L10.7 10.1 L11.4 9.6 L12.2 9.3 L13.2 9.4 L14.2 9.8 L14.9 10.6 L15.5 11.6 L15.6 12.8 L15.3 14.1 L14.5 15.2 L13.3 16.0 L11.9 16.4 L10.3 16.3 L8.8 15.6 L7.6 14.5 L6.9 12.9 L6.7 11.1 L7.1 9.2 L8.2 7.6 L9.8 6.4 L11.8 5.8 L14.0 5.9 L16.0 6.8 L17.7 8.3 L18.8 10.4 L19.1 12.8 L18.6 15.2 L17.3 17.4 L15.2 19.0 L12.7 19.9 L9.9 19.8 L7.3 18.9 L5.1 17.0" fill="none" />,
  // Petal Waltz — four-petal flower
  petals: (
    <>
      <path d="M12 12 C12 7 15 5 12 3 C9 5 12 7 12 12 Z" />
      <path d="M12 12 C12 17 15 19 12 21 C9 19 12 17 12 12 Z" />
      <path d="M12 12 C7 12 5 15 3 12 C5 9 7 12 12 12 Z" />
      <path d="M12 12 C17 12 19 15 21 12 C19 9 17 12 12 12 Z" />
    </>
  ),
  // Moonlance — a clean crescent moon
  moon: <path d="M16.5 3.2 a9 9 0 1 0 0 17.6 a11 11 0 0 1 0-17.6 Z" strokeLinejoin="round" />,
  // Starfall — a 5-point star (upper right) with two streaks trailing to lower-left,
  // aligned to the star's lower-left flank
  starfall: (
    <>
      <path d="M15.5 2.8 L17.0 6.9 L21.4 7.1 L18.0 9.8 L19.1 14.0 L15.5 11.6 L11.9 14.0 L13.0 9.8 L9.6 7.1 L14.0 6.9 Z" strokeLinejoin="round" />
      <path d="M12.5 12.5 L4 21 M10 11 L4.5 16.5" strokeLinecap="round" />
    </>
  ),
  // Shadowfang — a pair of downward-curving fangs
  umbra: (
    <>
      <path d="M8 5 C7.4 10 8 15 9.5 19 C10.4 16 10.6 10 10.2 5" strokeLinejoin="round" />
      <path d="M16 5 C16.6 10 16 15 14.5 19 C13.6 16 13.4 10 13.8 5" strokeLinejoin="round" />
      <path d="M6 5 H18" opacity="0.85" />
    </>
  ),
  // Astral Glaive — a crescent blade
  glaive: (
    <>
      <path d="M4 12 a8 8 0 0 1 16 0 a6 6 0 0 0-16 0 Z" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  // Nebula Bloom — a blossom of overlapping cloud lobes around a core
  nebula: (
    <>
      <circle cx="12" cy="8.4" r="3" />
      <circle cx="8.4" cy="13.5" r="3" />
      <circle cx="15.6" cy="13.5" r="3" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  // Sigil of Sleep — a warding triangle-in-circle sigil
  sigil: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 4 L19 16 H5 Z" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  // Soul Lanterns — a hanging lantern
  lantern: (
    <>
      <path d="M12 3 v2 M9 5 h6 M8 7 h8 l-1 11 H9 Z" strokeLinejoin="round" />
      <path d="M11 10 h2 M10.5 13 h3" />
    </>
  ),
  // Twilight Nova — two concentric rings (a hollow ripple)
  nova: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.2" />
    </>
  ),
};

// raw glyph body for embedding in a caller-controlled <svg> (e.g. tree nodes)
export function SpellIconInner({ id }: { id: string }) {
  return <>{P[id] ?? null}</>;
}

export function SpellIcon({ id, size = 20, className }: { id: string; size?: number; className?: string }) {
  const body = P[id];
  if (!body) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

export const HAS_ICON = (id: string) => id in P;
