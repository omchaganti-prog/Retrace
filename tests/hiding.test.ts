/**
 * The hiding layer.
 *
 * Shadow alcoves and the hideSpot markers that name them are two halves of one
 * feature: the tiles are what conceal you, the markers are what MIMIC sweeps and
 * what its memory of your habits is keyed on. They are edited by hand in two
 * different places, so these tests keep them from drifting apart — WING-01 had
 * shipped an alcove MIMIC could never think to search.
 */
import { describe, expect, it } from "vitest";
import { Level } from "../src/world/level";
import { Tile } from "../src/world/tiles";
import { WING01 } from "../src/world/wing01";

const level = new Level(WING01);

/** The tolerance game.ts uses when crediting a hide to a named spot. */
const CREDIT_RADIUS = 2;

function shadowTiles(): Array<{ tx: number; ty: number }> {
  const out: Array<{ tx: number; ty: number }> = [];
  for (let ty = 0; ty < WING01.h; ty++) {
    for (let tx = 0; tx < WING01.w; tx++) {
      if (level.at(tx, ty) === Tile.Shadow) out.push({ tx, ty });
    }
  }
  return out;
}

/** Flood-fills the shadow tiles into contiguous alcoves. */
function alcoves(): Array<Array<{ tx: number; ty: number }>> {
  const remaining = new Map(shadowTiles().map((t) => [`${t.tx},${t.ty}`, t]));
  const groups: Array<Array<{ tx: number; ty: number }>> = [];

  while (remaining.size > 0) {
    const [firstKey] = remaining.keys();
    const seed = remaining.get(firstKey)!;
    remaining.delete(firstKey);

    const group = [seed];
    const queue = [seed];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const key = `${cur.tx + dx},${cur.ty + dy}`;
        const hit = remaining.get(key);
        if (!hit) continue;
        remaining.delete(key);
        group.push(hit);
        queue.push(hit);
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Everything walkable you can actually reach from where the run begins. */
function reachableFromSpawn(): Set<string> {
  const seen = new Set<string>();
  const start = WING01.playerSpawn;
  const queue = [{ tx: start.tx, ty: start.ty }];
  seen.add(`${start.tx},${start.ty}`);

  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const tx = cur.tx + dx;
      const ty = cur.ty + dy;
      const key = `${tx},${ty}`;
      if (seen.has(key) || !level.inBounds(tx, ty)) continue;
      // Doors are walkable once open; treat only solid rock as impassable so
      // this measures layout rather than the current lock state.
      if (level.at(tx, ty) === Tile.Wall || level.at(tx, ty) === Tile.Void) continue;
      seen.add(key);
      queue.push({ tx, ty });
    }
  }
  return seen;
}

describe("WING-01 hiding places", () => {
  it("gives the player somewhere to break line of sight", () => {
    // A floor of coverage: fewer than this and whole stretches of the map are
    // a straight sprint with nowhere to duck.
    expect(WING01.hideSpots.length).toBeGreaterThanOrEqual(12);
  });

  it("puts every marker on an actual shadow tile", () => {
    for (const spot of WING01.hideSpots) {
      expect(level.at(spot.tx, spot.ty), `${spot.id} is not on shadow`).toBe(Tile.Shadow);
    }
  });

  it("names every alcove, so none is invisible to MIMIC's search", () => {
    for (const group of alcoves()) {
      const named = WING01.hideSpots.some((s) =>
        group.some(
          (t) =>
            Math.abs(s.tx - t.tx) <= CREDIT_RADIUS && Math.abs(s.ty - t.ty) <= CREDIT_RADIUS,
        ),
      );
      const where = `${group[0].tx},${group[0].ty}`;
      expect(named, `the alcove at ${where} has no hideSpot marker`).toBe(true);
    }
  });

  it("uses unique marker ids", () => {
    const ids = WING01.hideSpots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carves no alcove into solid rock or through a wall", () => {
    const reachable = reachableFromSpawn();
    for (const t of shadowTiles()) {
      // Unreachable means the carve landed outside the room it belonged to.
      expect(reachable.has(`${t.tx},${t.ty}`), `shadow at ${t.tx},${t.ty} is unreachable`).toBe(
        true,
      );
      expect(level.blocksMove(t.tx, t.ty)).toBe(false);
    }
  });

  it("spreads them out instead of clustering in one wing", () => {
    // Each alcove should serve a different part of the map; two markers close
    // enough to credit each other are really one hiding place wearing two names.
    for (let i = 0; i < WING01.hideSpots.length; i++) {
      for (let j = i + 1; j < WING01.hideSpots.length; j++) {
        const a = WING01.hideSpots[i];
        const b = WING01.hideSpots[j];
        const apart = Math.abs(a.tx - b.tx) > CREDIT_RADIUS || Math.abs(a.ty - b.ty) > CREDIT_RADIUS;
        expect(apart, `${a.id} and ${b.id} are the same hiding place`).toBe(true);
      }
    }
  });
});
