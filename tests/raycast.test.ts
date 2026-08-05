/**
 * `rayDistance` is what clips MIMIC's vision cone to the geometry. If it lies,
 * the cone is drawn through walls and the player is being told MIMIC can see
 * somewhere it cannot — a threat indicator that misleads is worse than none.
 */
import { describe, expect, it } from "vitest";
import { TILE } from "../src/core/constants";
import { rayBlocked, rayDistance } from "../src/systems/los";
import { tileCenter } from "../src/world/level";
import { testLevel } from "./helpers";

const level = testLevel();
const E = 0;
const W = Math.PI;
const N = -Math.PI / 2;

describe("rayDistance", () => {
  it("runs the full length down an open corridor", () => {
    // Row y=3 is clear all the way across.
    const from = tileCenter(1, 3);
    expect(rayDistance(level, from.x, from.y, E, 4 * TILE)).toBe(4 * TILE);
  });

  it("stops at the wall that blocks it", () => {
    // From (1,1) heading east, x=4 is a wall plug on this row.
    const from = tileCenter(1, 1);
    const d = rayDistance(level, from.x, from.y, E, 20 * TILE);
    // The wall's near face is at x = 4*TILE; the ray starts mid-tile at 1.5.
    expect(d).toBeCloseTo(2.5 * TILE, 3);
  });

  it("stops at the map border rather than running off the grid", () => {
    const from = tileCenter(1, 3);
    const d = rayDistance(level, from.x, from.y, W, 40 * TILE);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(TILE);
  });

  it("never reports further than the cap", () => {
    const from = tileCenter(3, 3);
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      expect(rayDistance(level, from.x, from.y, a, 3 * TILE)).toBeLessThanOrEqual(3 * TILE);
    }
  });

  it("agrees with rayBlocked about what is reachable", () => {
    // The two share a grid march; a disagreement means the cone and the AI's
    // line of sight have drifted apart.
    const from = tileCenter(1, 1);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const reach = 5 * TILE;
      const d = rayDistance(level, from.x, from.y, a, reach);
      // Just short of where the ray stopped must be clear line of sight.
      const safe = Math.max(0, d - 2);
      const tx = from.x + Math.cos(a) * safe;
      const ty = from.y + Math.sin(a) * safe;
      expect(
        rayBlocked(level, from.x, from.y, tx, ty),
        `angle ${a.toFixed(2)} blocked before its reported stop at ${d.toFixed(1)}`,
      ).toBe(false);
    }
  });

  it("is not fooled by a straight vertical or horizontal ray", () => {
    // Zero components in the direction vector are the classic divide-by-zero
    // case in a grid march.
    const from = tileCenter(1, 3);
    expect(Number.isFinite(rayDistance(level, from.x, from.y, N, 8 * TILE))).toBe(true);
    expect(Number.isFinite(rayDistance(level, from.x, from.y, E, 8 * TILE))).toBe(true);
  });
});
