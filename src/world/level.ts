import { TILE } from "../core/constants";
import {
  type Door,
  type DoorDef,
  type Prop,
  type PropDef,
  doorBlocksMove,
  doorBlocksSight,
  makeDoor,
  makeProp,
} from "./props";
import { Tile, isOpaqueTile, isWalkableTile } from "./tiles";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Inclusive-bounds rect helper: r(x0, y0, x1, y1). */
export const r = (x0: number, y0: number, x1: number, y1: number): Rect =>
  rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);

export interface ZoneDef {
  id: string;
  label: string;
  rects: Rect[];
}

export interface Marker {
  id: string;
  tx: number;
  ty: number;
  /**
   * Always included in MIMIC's patrol, whatever the strategy asks for.
   *
   * The normal patrol is built from strategy zones and only falls back to these
   * nodes when the strategy is too thin to fill a route — so a node the campaign
   * *depends* on being visited would otherwise be dead data. The containment
   * arch is the case: a required objective needs MIMIC to walk through it, and
   * hoping a zone ranking sends it there is not a guarantee.
   */
  mandatory?: boolean;
}

export interface LevelDef {
  id: string;
  name: string;
  w: number;
  h: number;
  /** Carved in order; later entries overwrite earlier ones. */
  carve: { area: Rect; tile: Tile }[];
  props: PropDef[];
  doors: DoorDef[];
  zones: ZoneDef[];
  playerSpawn: { tx: number; ty: number };
  mimicSpawn: { tx: number; ty: number };
  /** Waypoints MIMIC can patrol between. */
  patrolNodes: Marker[];
  /** Dark corners the game tracks as "hiding spots" for MIMIC's memory. */
  hideSpots: Marker[];
}

export class Level {
  readonly id: string;
  readonly name: string;
  readonly w: number;
  readonly h: number;
  readonly tiles: Uint8Array;
  /** Index into `zones` per tile, or -1. */
  readonly zoneAt: Int16Array;
  readonly zones: ZoneDef[];
  readonly props: Prop[];
  readonly doors: Door[];
  readonly propById = new Map<string, Prop>();
  readonly doorById = new Map<string, Door>();
  readonly patrolNodes: Marker[];
  readonly hideSpots: Marker[];
  readonly playerSpawn: { x: number; y: number };
  readonly mimicSpawn: { x: number; y: number };

  private doorIndex = new Map<number, Door>();
  /** Cached tile-variant pick so art does not shimmer between frames. */
  readonly variant: Uint8Array;

  constructor(def: LevelDef) {
    this.id = def.id;
    this.name = def.name;
    this.w = def.w;
    this.h = def.h;
    this.tiles = new Uint8Array(def.w * def.h).fill(Tile.Wall);
    this.zoneAt = new Int16Array(def.w * def.h).fill(-1);
    this.zones = def.zones;
    this.variant = new Uint8Array(def.w * def.h);

    for (const step of def.carve) this.fill(step.area, step.tile);

    // A hard wall border, so nothing can ever walk off the grid.
    for (let x = 0; x < def.w; x++) {
      this.set(x, 0, Tile.Wall);
      this.set(x, def.h - 1, Tile.Wall);
    }
    for (let y = 0; y < def.h; y++) {
      this.set(0, y, Tile.Wall);
      this.set(def.w - 1, y, Tile.Wall);
    }

    this.props = def.props.map(makeProp);
    for (const p of this.props) this.propById.set(p.id, p);

    this.doors = def.doors.map(makeDoor);
    for (const d of this.doors) {
      // A door tile is floor in the grid; the door object supplies the blocking.
      this.set(d.tx, d.ty, Tile.Floor);
      this.doorById.set(d.id, d);
      this.doorIndex.set(this.idx(d.tx, d.ty), d);
    }
    // Orientation depends on which neighbours are open, so resolve it after all
    // carving and door placement is done.
    for (const d of this.doors) {
      const openNS =
        isWalkableTile(this.at(d.tx, d.ty - 1)) && isWalkableTile(this.at(d.tx, d.ty + 1));
      d.passageNS = openNS;
    }

    this.patrolNodes = def.patrolNodes;
    this.hideSpots = def.hideSpots;
    this.playerSpawn = tileCenter(def.playerSpawn.tx, def.playerSpawn.ty);
    this.mimicSpawn = tileCenter(def.mimicSpawn.tx, def.mimicSpawn.ty);

    this.assignZones();
    this.assignVariants();
  }

  idx(tx: number, ty: number): number {
    return ty * this.w + tx;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  at(tx: number, ty: number): Tile {
    if (!this.inBounds(tx, ty)) return Tile.Void;
    return this.tiles[ty * this.w + tx] as Tile;
  }

  set(tx: number, ty: number, t: Tile): void {
    if (!this.inBounds(tx, ty)) return;
    this.tiles[ty * this.w + tx] = t;
  }

  fill(a: Rect, t: Tile): void {
    for (let y = a.y; y < a.y + a.h; y++) {
      for (let x = a.x; x < a.x + a.w; x++) this.set(x, y, t);
    }
  }

  doorAt(tx: number, ty: number): Door | undefined {
    return this.doorIndex.get(this.idx(tx, ty));
  }

  /** Solid for movement? */
  blocksMove(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    if (!isWalkableTile(this.at(tx, ty))) return true;
    const d = this.doorIndex.get(this.idx(tx, ty));
    return d ? doorBlocksMove(d) : false;
  }

  /** Opaque for line-of-sight? */
  blocksSight(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    if (isOpaqueTile(this.at(tx, ty))) return true;
    const d = this.doorIndex.get(this.idx(tx, ty));
    return d ? doorBlocksSight(d) : false;
  }

  zoneIdAt(tx: number, ty: number): string | null {
    if (!this.inBounds(tx, ty)) return null;
    const z = this.zoneAt[this.idx(tx, ty)];
    return z < 0 ? null : this.zones[z].id;
  }

  zoneLabel(id: string): string {
    return this.zones.find((z) => z.id === id)?.label ?? id;
  }

  /** World-space centre of a zone, used for patrol/guard targets. */
  zoneCenter(id: string): { x: number; y: number } | null {
    const i = this.zones.findIndex((z) => z.id === id);
    if (i < 0) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let ty = 0; ty < this.h; ty++) {
      for (let tx = 0; tx < this.w; tx++) {
        if (this.zoneAt[this.idx(tx, ty)] === i && !this.blocksMove(tx, ty)) {
          sx += tx;
          sy += ty;
          n++;
        }
      }
    }
    if (n === 0) return null;
    return tileCenter(Math.round(sx / n), Math.round(sy / n));
  }

  /** Nearest walkable tile to (tx, ty), searched outward. Used to sanitise targets. */
  nearestOpen(tx: number, ty: number, maxR = 12): { tx: number; ty: number } | null {
    if (!this.blocksMove(tx, ty)) return { tx, ty };
    for (let rad = 1; rad <= maxR; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (!this.blocksMove(nx, ny)) return { tx: nx, ty: ny };
        }
      }
    }
    return null;
  }

  private assignZones(): void {
    for (let i = 0; i < this.zones.length; i++) {
      for (const a of this.zones[i].rects) {
        for (let y = a.y; y < a.y + a.h; y++) {
          for (let x = a.x; x < a.x + a.w; x++) {
            if (this.inBounds(x, y)) this.zoneAt[this.idx(x, y)] = i;
          }
        }
      }
    }
    // Flood the leftovers (connector corridors, door tiles) out from the tiles
    // that already have an owner, so every walkable tile belongs somewhere.
    const queue: number[] = [];
    for (let i = 0; i < this.zoneAt.length; i++) if (this.zoneAt[i] >= 0) queue.push(i);
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const tx = i % this.w;
      const ty = (i / this.w) | 0;
      const z = this.zoneAt[i];
      for (const [dx, dy] of NEIGHBOURS4) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.zoneAt[ni] >= 0) continue;
        if (!isWalkableTile(this.at(nx, ny))) continue;
        this.zoneAt[ni] = z;
        queue.push(ni);
      }
    }
  }

  private assignVariants(): void {
    let s = 0x1f3d5b79;
    for (let i = 0; i < this.variant.length; i++) {
      s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x9e3779b9) >>> 0;
      this.variant[i] = s >>> 27;
    }
  }
}

export const NEIGHBOURS4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const NEIGHBOURS8: readonly (readonly [number, number])[] = [
  ...NEIGHBOURS4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

export function toTileX(x: number): number {
  return Math.floor(x / TILE);
}

export function toTileY(y: number): number {
  return Math.floor(y / TILE);
}

/**
 * Flood fill from a tile across walkable tiles, ignoring door state (doors are
 * treated as passable). Used by the level validator to prove the wing is
 * solvable — a puzzle behind an unreachable door is a hard failure.
 */
export function reachableTiles(level: Level, fromTx: number, fromTy: number): Set<number> {
  const seen = new Set<number>();
  if (!level.inBounds(fromTx, fromTy)) return seen;
  const start = level.idx(fromTx, fromTy);
  const stack = [start];
  seen.add(start);
  while (stack.length) {
    const i = stack.pop()!;
    const tx = i % level.w;
    const ty = (i / level.w) | 0;
    for (const [dx, dy] of NEIGHBOURS4) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!level.inBounds(nx, ny)) continue;
      if (!isWalkableTile(level.at(nx, ny))) continue;
      const ni = level.idx(nx, ny);
      if (seen.has(ni)) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  return seen;
}
