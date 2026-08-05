/**
 * Circle-vs-grid movement, resolved one axis at a time so agents slide along
 * walls instead of sticking to them. Sliding is not cosmetic here: the player is
 * expected to hug walls while sneaking, and MIMIC's A* waypoints cut corners
 * tight enough that a non-sliding resolver wedges it on every pillar.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import { TILE } from "../core/constants";
import type { Level } from "../world/level";

export interface MoveResult {
  x: number;
  y: number;
  hitX: boolean;
  hitY: boolean;
}

/** Nudge used to park the body just clear of a surface it collided with. */
const SKIN = 0.01;

export function moveCircle(
  level: Level,
  x: number,
  y: number,
  radius: number,
  dx: number,
  dy: number,
): MoveResult {
  let px = x + dx;
  let hitX = false;

  if (dx !== 0) {
    const minTy = Math.floor((y - radius) / TILE);
    const maxTy = Math.floor((y + radius) / TILE);
    const edge = dx > 0 ? px + radius : px - radius;
    const tx = Math.floor(edge / TILE);
    for (let ty = minTy; ty <= maxTy; ty++) {
      if (!level.blocksMove(tx, ty)) continue;
      px = dx > 0 ? tx * TILE - radius - SKIN : (tx + 1) * TILE + radius + SKIN;
      hitX = true;
      break;
    }
  }

  let py = y + dy;
  let hitY = false;

  if (dy !== 0) {
    // Uses the already-resolved px so a corner cannot be clipped diagonally.
    const minTx = Math.floor((px - radius) / TILE);
    const maxTx = Math.floor((px + radius) / TILE);
    const edge = dy > 0 ? py + radius : py - radius;
    const ty = Math.floor(edge / TILE);
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!level.blocksMove(tx, ty)) continue;
      py = dy > 0 ? ty * TILE - radius - SKIN : (ty + 1) * TILE + radius + SKIN;
      hitY = true;
      break;
    }
  }

  return { x: px, y: py, hitX, hitY };
}
