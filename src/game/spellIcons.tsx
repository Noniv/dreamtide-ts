// Inline SVG spell icons. The alchemical Unicode glyphs originally used (🜁🜂🜄…)
// live in a Unicode block with almost no cross-platform font coverage, so they
// vanished on Linux. These hand-drawn SVGs render identically everywhere and
// inherit the spell colour via `currentColor`.
//
// The raw geometry lives in ICON_PARTS (a 24×24 viewBox, stroked with
// currentColor) so both the React components here and the canvas-based
// constellation renderer can draw the same icons.
import React from 'react';

export interface IconPart {
  d?: string;                    // SVG path, stroked
  c?: [number, number, number];  // circle [cx, cy, r]
  fill?: boolean;                // fill with currentColor instead of stroking
  opacity?: number;
}

export const ICON_PARTS: Record<string, IconPart[]> = {
  // Arcane Missiles — a four-pointed seeker star with a small centre dot
  arcane: [
    { d: 'M12 2.5 L14.1 9.9 L21.5 12 L14.1 14.1 L12 21.5 L9.9 14.1 L2.5 12 L9.9 9.9 Z' },
    { c: [12, 12, 1.2], fill: true },
  ],
  // Emberfall — a rounded but slim flame with an inner curl
  ember: [
    { d: 'M12 2.5 C12.6 6 16.5 8.5 16.5 13.5 a4.5 4.5 0 0 1-9 0 C7.5 10.5 9 9.5 9.8 7.5 C10.2 9 11 9.6 12 10 C13 9.2 12.6 5 12 2.5 Z' },
  ],
  // Frostbloom — six-armed snowflake with outward-opening dendrites
  frost: [
    { d: 'M12 2.5 V21.5 M3.77 7.25 L20.23 16.75 M20.23 7.25 L3.77 16.75' },
    { d: 'M12.0 5.8 L9.5 3.8 M12.0 5.8 L14.5 3.8' },
    { d: 'M17.4 8.9 L17.8 5.7 M17.4 8.9 L20.3 10.1' },
    { d: 'M17.4 15.1 L20.3 13.9 M17.4 15.1 L17.8 18.3' },
    { d: 'M12.0 18.2 L14.5 20.2 M12.0 18.2 L9.5 20.2' },
    { d: 'M6.6 15.1 L6.2 18.3 M6.6 15.1 L3.7 13.9' },
    { d: 'M6.6 8.9 L3.7 10.1 M6.6 8.9 L6.2 5.7' },
  ],
  // Stormcall — a lightning bolt that tapers to a point at both ends
  storm: [{ d: 'M14.5 1.5 L5 12.5 L10.5 12.5 L9 22.5 L19 10.5 L13.5 10.5 Z' }],
  // Void Rift — an Archimedean spiral collapsing to the centre
  void: [{ d: 'M12.0 12.0 L12.2 12.1 L12.3 12.2 L12.3 12.5 L12.2 12.8 L11.9 13.0 L11.5 13.0 L11.0 12.9 L10.6 12.6 L10.3 12.1 L10.1 11.5 L10.3 10.8 L10.7 10.1 L11.4 9.6 L12.2 9.3 L13.2 9.4 L14.2 9.8 L14.9 10.6 L15.5 11.6 L15.6 12.8 L15.3 14.1 L14.5 15.2 L13.3 16.0 L11.9 16.4 L10.3 16.3 L8.8 15.6 L7.6 14.5 L6.9 12.9 L6.7 11.1 L7.1 9.2 L8.2 7.6 L9.8 6.4 L11.8 5.8 L14.0 5.9 L16.0 6.8 L17.7 8.3 L18.8 10.4 L19.1 12.8 L18.6 15.2 L17.3 17.4 L15.2 19.0 L12.7 19.9 L9.9 19.8 L7.3 18.9 L5.1 17.0' }],
  // Petal Waltz — four-petal flower
  petals: [
    { d: 'M12 12 C12 7 15 5 12 3 C9 5 12 7 12 12 Z' },
    { d: 'M12 12 C12 17 15 19 12 21 C9 19 12 17 12 12 Z' },
    { d: 'M12 12 C7 12 5 15 3 12 C5 9 7 12 12 12 Z' },
    { d: 'M12 12 C17 12 19 15 21 12 C19 9 17 12 12 12 Z' },
  ],
  // Moonlance — a clean crescent moon
  moon: [{ d: 'M16.5 3.2 a9 9 0 1 0 0 17.6 a11 11 0 0 1 0-17.6 Z' }],
  // Starfall — a 5-point star with two streaks trailing to lower-left
  starfall: [
    { d: 'M15.5 2.8 L17.0 6.9 L21.4 7.1 L18.0 9.8 L19.1 14.0 L15.5 11.6 L11.9 14.0 L13.0 9.8 L9.6 7.1 L14.0 6.9 Z' },
    { d: 'M12.5 12.5 L4 21 M10 11 L4.5 16.5' },
  ],
  // Shadowfang — a pair of downward-curving fangs
  umbra: [
    { d: 'M8 5 C7.4 10 8 15 9.5 19 C10.4 16 10.6 10 10.2 5' },
    { d: 'M16 5 C16.6 10 16 15 14.5 19 C13.6 16 13.4 10 13.8 5' },
    { d: 'M6 5 H18', opacity: 0.85 },
  ],
  // Astral Glaive — a crescent blade
  glaive: [
    { d: 'M4 12 a8 8 0 0 1 16 0 a6 6 0 0 0-16 0 Z' },
    { c: [12, 12, 1.4], fill: true },
  ],
  // Nebula Bloom — a blossom of overlapping cloud lobes around a core
  nebula: [
    { c: [12, 8.4, 3] },
    { c: [8.4, 13.5, 3] },
    { c: [15.6, 13.5, 3] },
    { c: [12, 12, 1.8], fill: true },
  ],
  // Sigil of Sleep — a warding triangle-in-circle sigil
  sigil: [
    { c: [12, 12, 9] },
    { d: 'M12 4 L19 16 H5 Z' },
    { c: [12, 12, 1.6], fill: true },
  ],
  // Soul Lanterns — a hanging lantern
  lantern: [
    { d: 'M12 3 v2 M9 5 h6 M8 7 h8 l-1 11 H9 Z' },
    { d: 'M11 10 h2 M10.5 13 h3' },
  ],
  // Twilight Nova — two concentric rings (a hollow ripple)
  nova: [
    { c: [12, 12, 8.5] },
    { c: [12, 12, 4.2] },
  ],
  // Wisp Choir — three trailing spirits in a rising arc
  wisps: [
    { d: 'M6 18 Q 10 12 15.5 7', opacity: 0.55 },
    { c: [15.8, 6.6, 2.4], fill: true },
    { c: [11, 11.6, 2], fill: true },
    { c: [6.4, 17.4, 1.6], fill: true },
  ],
  // Dream Serpent — a swimming sine wave with a crested head
  serpent: [
    { d: 'M3.5 15.5 C6 10 8.5 10 11 13.8 C13 16.9 15.3 16.9 17 13.5' },
    { c: [18.8, 11.5, 2.4] },
    { c: [19.5, 10.7, 0.7], fill: true },
  ],
  // Chime of Hours — a hanging bell with a clapper
  chime: [
    { d: 'M12 4.2 v2.2' },
    { d: 'M8.4 18 C8.4 12.4 9.6 8.6 12 6.6 C14.4 8.6 15.6 12.4 15.6 18 Z' },
    { d: 'M6.8 18 H17.2' },
    { c: [12, 20.2, 1.1], fill: true },
  ],
  // Sleepless Eye — an open eye with iris and three rays of its gaze
  eye: [
    { d: 'M3 12 C6.5 7.4 17.5 7.4 21 12 C17.5 16.6 6.5 16.6 3 12 Z' },
    { c: [12, 12, 3.1] },
    { c: [12, 12, 1.1], fill: true },
    { d: 'M12 2.6 V5 M4.6 5.4 L6.3 7.1 M19.4 5.4 L17.7 7.1', opacity: 0.85 },
  ],
  // Nightmare Brand — a target rune, crosshair reaching past the ring
  brand: [
    { c: [12, 12, 5.4] },
    { d: 'M12 1.8 V6.6 M12 17.4 V22.2 M1.8 12 H6.6 M17.4 12 H22.2' },
    { c: [12, 12, 1.4], fill: true },
  ],
  // Kaleidoscope — a glass prism splitting a ray into a diverging fan
  prism: [
    { d: 'M12 5 L18.5 16.5 H5.5 Z' },
    { d: 'M2.5 15.5 H7.5', opacity: 0.9 },
    { d: 'M16 12.5 L22 11 M16.4 14 L22.4 14 M16 15.5 L22 17', opacity: 0.9 },
  ],
};

// raw glyph body for embedding in a caller-controlled <svg> (e.g. tree nodes)
export function SpellIconInner({ id }: { id: string }) {
  const parts = ICON_PARTS[id];
  if (!parts) return null;
  return (
    <>
      {parts.map((p, i) =>
        p.d
          ? <path key={i} d={p.d} opacity={p.opacity} fill={p.fill ? 'currentColor' : undefined} stroke={p.fill ? 'none' : undefined} />
          : <circle key={i} cx={p.c![0]} cy={p.c![1]} r={p.c![2]} opacity={p.opacity} fill={p.fill ? 'currentColor' : 'none'} stroke={p.fill ? 'none' : undefined} />
      )}
    </>
  );
}

export function SpellIcon({ id, size = 20, className }: { id: string; size?: number; className?: string }) {
  if (!ICON_PARTS[id]) return null;
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
      <SpellIconInner id={id} />
    </svg>
  );
}

export const HAS_ICON = (id: string) => id in ICON_PARTS;
