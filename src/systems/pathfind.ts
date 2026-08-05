/**
 * A* over the tile grid. MIMIC needs it to actually round corners in the
 * service warren — pure line-of-sight steering gets stuck on the first pillar.
 *
 * Auto hatches are treated as passable (they slide open for anything that walks
 * up to them). Security gates are passable only while their plates are held, so
 * MIMIC genuinely cannot follow you through a gate you closed behind you.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import { TILE } from "../core/constants";
import { type Level, NEIGHBOURS8, tileCenter } from "../world/level";
import { doorBlocksMove } from "../world/props";
import { isWalkableTile } from "../world/tiles";

export function pathPassable(level: Level, tx: number, ty: number): boolean {
  if (!level.inBounds(tx, ty)) return false;
  if (!isWalkableTile(level.at(tx, ty))) return false;
  const d = level.doorAt(tx, ty);
  if (!d) return true;
  // A MIMIC security lock is solid to everyone, including MIMIC.
  if (d.lockedT > 0) return false;
  if (d.rule.kind === "auto") return true;
  return !doorBlocksMove(d);
}

const SQRT2 = Math.SQRT2;

/**
 * Returns world-space waypoints from start to goal (excluding the start tile),
 * or null if unreachable within the node budget.
 */
export function findPath(
  level: Level,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  maxNodes = 6000,
): { x: number; y: number }[] | null {
  const startX = Math.floor(sx / TILE);
  const startY = Math.floor(sy / TILE);
  let goalX = Math.floor(gx / TILE);
  let goalY = Math.floor(gy / TILE);

  if (!level.inBounds(startX, startY)) return null;
  if (!pathPassable(level, goalX, goalY)) {
    const near = level.nearestOpen(goalX, goalY, 6);
    if (!near) return null;
    goalX = near.tx;
    goalY = near.ty;
  }
  if (startX === goalX && startY === goalY) return [];

  const w = level.w;
  const size = w * level.h;
  const gScore = new Float32Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  const heuristic = (tx: number, ty: number): number => {
    const dx = Math.abs(tx - goalX);
    const dy = Math.abs(ty - goalY);
    // Octile distance.
    return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
  };

  const openIdx: number[] = [];
  const openF: number[] = [];
  const push = (i: number, f: number): void => {
    openIdx.push(i);
    openF.push(f);
    let c = openIdx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (openF[p] <= openF[c]) break;
      [openF[p], openF[c]] = [openF[c], openF[p]];
      [openIdx[p], openIdx[c]] = [openIdx[c], openIdx[p]];
      c = p;
    }
  };
  const pop = (): number => {
    const top = openIdx[0];
    const li = openIdx.pop()!;
    const lf = openF.pop()!;
    if (openIdx.length > 0) {
      openIdx[0] = li;
      openF[0] = lf;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < openIdx.length && openF[l] < openF[m]) m = l;
        if (r < openIdx.length && openF[r] < openF[m]) m = r;
        if (m === c) break;
        [openF[m], openF[c]] = [openF[c], openF[m]];
        [openIdx[m], openIdx[c]] = [openIdx[c], openIdx[m]];
        c = m;
      }
    }
    return top;
  };

  const startI = startY * w + startX;
  const goalI = goalY * w + goalX;
  gScore[startI] = 0;
  push(startI, heuristic(startX, startY));

  let expanded = 0;
  while (openIdx.length > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalI) break;
    if (++expanded > maxNodes) return null;

    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy] of NEIGHBOURS8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!pathPassable(level, nx, ny)) continue;
      // No cutting diagonally through the gap between two walls.
      if (dx !== 0 && dy !== 0) {
        if (!pathPassable(level, cx + dx, cy) || !pathPassable(level, cx, cy + dy)) continue;
      }
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const step = dx !== 0 && dy !== 0 ? SQRT2 : 1;
      const tentative = gScore[cur] + step;
      if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        cameFrom[ni] = cur;
        push(ni, tentative + heuristic(nx, ny));
      }
    }
  }

  if (!Number.isFinite(gScore[goalI])) return null;

  const out: { x: number; y: number }[] = [];
  let cur = goalI;
  while (cur !== startI && cur >= 0) {
    out.push(tileCenter(cur % w, (cur / w) | 0));
    cur = cameFrom[cur];
    if (cur === -1) return null;
  }
  out.reverse();
  return out;
}
