/**
 * 2D visibility.
 *
 * Grid raycasting (Amanatides-Woo voxel traversal) rather than a visibility
 * polygon: the world is tile-based, MIMIC only ever needs point-to-point
 * queries, and the player's fog is rendered per tile anyway. The behaviour is
 * the one described in Amit Patel's 2D-visibility write-up — walls cast hard
 * shadows, and nothing is visible around a corner.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import { TILE } from "../core/constants";
import { clamp, smoothstep } from "../core/math";
import type { Level } from "../world/level";

/**
 * True if a wall (or sealed door) sits between the two world-space points.
 * The tile containing the destination never blocks — otherwise a wall could
 * never be seen from the corridor in front of it.
 */
export function rayBlocked(
  level: Level,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  let tx = Math.floor(x0 / TILE);
  let ty = Math.floor(y0 / TILE);
  const endX = Math.floor(x1 / TILE);
  const endY = Math.floor(y1 / TILE);
  if (tx === endX && ty === endY) return false;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  // Parametric distance (in units of t along the ray) to cross one full tile.
  const tDeltaX = dx === 0 ? Infinity : Math.abs(TILE / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(TILE / dy);

  // Distance to the first grid line in each axis.
  const nextBoundaryX = (tx + (stepX > 0 ? 1 : 0)) * TILE;
  const nextBoundaryY = (ty + (stepY > 0 ? 1 : 0)) * TILE;
  let tMaxX = dx === 0 ? Infinity : (nextBoundaryX - x0) / dx;
  let tMaxY = dy === 0 ? Infinity : (nextBoundaryY - y0) / dy;

  // Bounded: the ray can never cross more tiles than the grid is wide+tall.
  const limit = level.w + level.h + 4;
  for (let i = 0; i < limit; i++) {
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) return false;
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > 1) return false;
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (tx === endX && ty === endY) return false;
    if (level.blocksSight(tx, ty)) return true;
  }
  return false;
}

/**
 * How far a ray travels from a point before a wall stops it, in world units,
 * capped at `maxDist`. Same grid march as `rayBlocked`, but it reports the hit
 * distance instead of a yes/no — which is what lets a vision cone be drawn as
 * the shape it actually covers rather than an arc painted straight through the
 * facility's walls.
 */
export function rayDistance(
  level: Level,
  x0: number,
  y0: number,
  angle: number,
  maxDist: number,
): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let tx = Math.floor(x0 / TILE);
  let ty = Math.floor(y0 / TILE);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  // The direction is a unit vector, so t is already a world-space distance.
  const tDeltaX = dx === 0 ? Infinity : Math.abs(TILE / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(TILE / dy);
  let tMaxX = dx === 0 ? Infinity : ((tx + (stepX > 0 ? 1 : 0)) * TILE - x0) / dx;
  let tMaxY = dy === 0 ? Infinity : ((ty + (stepY > 0 ? 1 : 0)) * TILE - y0) / dy;

  const limit = level.w + level.h + 4;
  for (let i = 0; i < limit; i++) {
    const t = Math.min(tMaxX, tMaxY);
    if (t >= maxDist) return maxDist;
    if (tMaxX < tMaxY) {
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (!level.inBounds(tx, ty) || level.blocksSight(tx, ty)) return t;
  }
  return maxDist;
}

export function hasLineOfSight(
  level: Level,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return !rayBlocked(level, x0, y0, x1, y1);
}

export interface Cone {
  x: number;
  y: number;
  /** Centre of the cone, in radians. */
  facing: number;
  /** Half-width of the cone, in radians. */
  halfAngle: number;
  /** Maximum sight distance, in world pixels. */
  range: number;
  /** Inside this distance the cone is ignored — you cannot hug its blind spot. */
  peripheral: number;
}

/**
 * How strongly `cone` can see the point, in 0..1. Zero means "not seen at all".
 * Falls off toward the edge of the cone and with distance, so a target at the
 * far edge of vision is detected more slowly than one dead ahead.
 */
export function coneVisibility(level: Level, cone: Cone, px: number, py: number): number {
  const dx = px - cone.x;
  const dy = py - cone.y;
  const d = Math.hypot(dx, dy);
  if (d > cone.range) return 0;

  let shape: number;
  if (d <= cone.peripheral) {
    shape = 1;
  } else {
    const ang = Math.atan2(dy, dx);
    let diff = Math.abs(((ang - cone.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    diff = Math.abs(diff);
    if (diff > cone.halfAngle) return 0;
    // Soft edge over the outer quarter of the cone.
    shape = 1 - smoothstep(cone.halfAngle * 0.7, cone.halfAngle, diff);
  }

  // Detection weakens with distance but never quite vanishes inside range.
  const falloff = 1 - 0.6 * smoothstep(cone.range * 0.45, cone.range, d);
  if (rayBlocked(level, cone.x, cone.y, px, py)) return 0;
  return clamp(shape * falloff, 0, 1);
}

/**
 * Per-tile light/visibility for the player's fog of war. `lit` is recomputed
 * every frame; `seen` is sticky so explored geometry stays faintly drawn.
 */
export class FogField {
  readonly lit: Float32Array;
  readonly seen: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.lit = new Float32Array(w * h);
    this.seen = new Uint8Array(w * h);
  }

  reset(): void {
    this.lit.fill(0);
    this.seen.fill(0);
  }

  litAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return 0;
    return this.lit[ty * this.w + tx];
  }

  seenAt(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.seen[ty * this.w + tx] !== 0;
  }

  /**
   * 360-degree visibility from a world-space point. Each tile is sampled at its
   * centre plus four inset corners, so edges soften instead of popping.
   */
  compute(level: Level, ox: number, oy: number, radiusTiles: number): void {
    this.lit.fill(0);
    const rPx = radiusTiles * TILE;
    const ctx = Math.floor(ox / TILE);
    const cty = Math.floor(oy / TILE);
    const rad = Math.ceil(radiusTiles);
    const inset = 3;

    for (let ty = cty - rad; ty <= cty + rad; ty++) {
      if (ty < 0 || ty >= this.h) continue;
      for (let tx = ctx - rad; tx <= ctx + rad; tx++) {
        if (tx < 0 || tx >= this.w) continue;
        const cx = tx * TILE + TILE / 2;
        const cy = ty * TILE + TILE / 2;
        const d = Math.hypot(cx - ox, cy - oy);
        if (d > rPx + TILE) continue;

        let hits = 0;
        const samples: [number, number][] = [
          [cx, cy],
          [tx * TILE + inset, ty * TILE + inset],
          [tx * TILE + TILE - inset, ty * TILE + inset],
          [tx * TILE + inset, ty * TILE + TILE - inset],
          [tx * TILE + TILE - inset, ty * TILE + TILE - inset],
        ];
        for (const [sx, sy] of samples) {
          if (Math.hypot(sx - ox, sy - oy) > rPx) continue;
          if (!rayBlocked(level, ox, oy, sx, sy)) hits++;
        }
        if (hits === 0) continue;

        const frac = hits / samples.length;
        const falloff = 1 - smoothstep(rPx * 0.45, rPx, d);
        const v = clamp(frac * (0.25 + 0.75 * falloff), 0, 1);
        const i = ty * this.w + tx;
        if (v > this.lit[i]) this.lit[i] = v;
        if (v > 0.08) this.seen[i] = 1;
      }
    }
  }
}
