export const enum Tile {
  Void = 0,
  Floor = 1,
  Wall = 2,
  /** Metal grating: walkable, but footsteps carry much further. */
  Grate = 3,
  /** Unlit alcove: walkable, and standing in it makes you far harder to see. */
  Shadow = 4,
}

export const TILE_NAMES = ["void", "floor", "wall", "grate", "shadow"] as const;

export function isWalkableTile(t: Tile): boolean {
  return t === Tile.Floor || t === Tile.Grate || t === Tile.Shadow;
}

export function isOpaqueTile(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.Void;
}

/** Multiplier applied to the loudness of footsteps taken on this tile. */
export function footstepGain(t: Tile): number {
  if (t === Tile.Grate) return 1.9;
  if (t === Tile.Shadow) return 0.75;
  return 1;
}
