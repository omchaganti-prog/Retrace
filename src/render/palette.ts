/**
 * Deliberately limited palette: cool blues/greys for the facility, cyan for the
 * player, red/black for MIMIC, amber for powered tech. Nothing outside this list
 * should appear in gameplay art.
 */
export const PAL = {
  void: "#04070c",
  floorDark: "#0d141f",
  floor: "#121b28",
  floorLit: "#1a2536",
  floorSeam: "#0a111a",
  grate: "#16202e",

  wall: "#1d2839",
  wallFace: "#2a3a52",
  wallEdge: "#3f5677",
  wallShadow: "#080d15",

  cyan: "#55e2ff",
  cyanBright: "#b7f4ff",
  cyanDim: "#2b7f9c",
  cyanDeep: "#154a5e",

  echo: "#7de6ff",
  echoDim: "#2f6f88",

  red: "#ff2b45",
  redBright: "#ff8f9f",
  redDeep: "#7a0f20",
  mimicBody: "#120a10",
  mimicRim: "#2e1622",

  amber: "#ffb347",
  amberDim: "#8a5a1c",
  green: "#46e0a0",
  greenDim: "#1d6b4c",

  white: "#eaf6ff",
  grey: "#6d8092",
  greyDark: "#3a4757",
  black: "#000000",
} as const;

export type PaletteKey = keyof typeof PAL;

/** #rrggbb -> rgba(...) with the given alpha. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Blend two hex colours; t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const r = Math.round(((na >> 16) & 255) * (1 - t) + ((nb >> 16) & 255) * t);
  const g = Math.round(((na >> 8) & 255) * (1 - t) + ((nb >> 8) & 255) * t);
  const bl = Math.round((na & 255) * (1 - t) + (nb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
