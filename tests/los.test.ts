/**
 * Acceptance criterion: "verify areas behind walls are not rendered. Test that
 * closed vs open doors change visibility."
 */
import { describe, expect, it } from "vitest";
import { LIGHT, MIMIC, TILE } from "../src/core/constants";
import { type Cone, FogField, coneVisibility, hasLineOfSight } from "../src/systems/los";
import { tileCenter } from "../src/world/level";
import { testLevel } from "./helpers";

const at = (tx: number, ty: number) => tileCenter(tx, ty);

describe("line of sight", () => {
  it("is blocked by a wall and clear along an open corridor", () => {
    const level = testLevel();
    const a = at(2, 1);
    const b = at(6, 1);
    expect(hasLineOfSight(level, a.x, a.y, b.x, b.y)).toBe(false);

    const c = at(2, 3);
    const d = at(6, 3);
    expect(hasLineOfSight(level, c.x, c.y, d.x, d.y)).toBe(true);
  });

  it("treats a closed door as opaque and an open one as clear", () => {
    const level = testLevel("auto");
    const door = level.doorById.get("door")!;
    const a = at(2, 3);
    const b = at(6, 3);

    door.openness = 0;
    expect(hasLineOfSight(level, a.x, a.y, b.x, b.y)).toBe(false);

    door.openness = 1;
    expect(hasLineOfSight(level, a.x, a.y, b.x, b.y)).toBe(true);
  });

  it("sees a target dead ahead but not one behind it", () => {
    const level = testLevel();
    const origin = at(3, 3);
    const cone: Cone = {
      x: origin.x,
      y: origin.y,
      facing: 0, // east
      halfAngle: MIMIC.coneHalfAngle,
      range: MIMIC.visionTiles * TILE,
      peripheral: MIMIC.peripheralTiles * TILE,
    };

    const ahead = at(6, 3);
    expect(coneVisibility(level, cone, ahead.x, ahead.y)).toBeGreaterThan(0);

    const behind = at(1, 3);
    expect(coneVisibility(level, cone, behind.x, behind.y)).toBe(0);
  });

  it("cannot be hugged from behind at zero range", () => {
    const level = testLevel();
    const origin = at(3, 3);
    const cone: Cone = {
      x: origin.x,
      y: origin.y,
      facing: 0,
      halfAngle: MIMIC.coneHalfAngle,
      range: MIMIC.visionTiles * TILE,
      peripheral: MIMIC.peripheralTiles * TILE,
    };
    // Directly behind, but inside the peripheral radius.
    expect(coneVisibility(level, cone, origin.x - 8, origin.y)).toBeGreaterThan(0);
  });

  it("cannot see a target through a wall even inside the cone", () => {
    const level = testLevel();
    const origin = at(2, 1);
    const cone: Cone = {
      x: origin.x,
      y: origin.y,
      facing: 0,
      halfAngle: MIMIC.coneHalfAngle,
      range: MIMIC.visionTiles * TILE,
      peripheral: MIMIC.peripheralTiles * TILE,
    };
    const behindWall = at(6, 1);
    expect(coneVisibility(level, cone, behindWall.x, behindWall.y)).toBe(0);
  });
});

describe("fog of war", () => {
  it("lights what is visible, remembers what was, and leaves the rest unseen", () => {
    const level = testLevel();
    const fog = new FogField(level.w, level.h);
    const origin = at(2, 1);
    fog.compute(level, origin.x, origin.y, LIGHT.playerRadiusTiles);

    expect(fog.litAt(3, 1)).toBeGreaterThan(0);
    expect(fog.seenAt(3, 1)).toBe(true);
    // Behind the wall plug on row 1.
    expect(fog.litAt(6, 1)).toBe(0);
    expect(fog.seenAt(6, 1)).toBe(false);

    // Walk to the far side: the old tile stays "seen" but stops being lit.
    const far = at(6, 1);
    fog.compute(level, far.x, far.y, LIGHT.playerRadiusTiles);
    expect(fog.litAt(2, 1)).toBe(0);
    expect(fog.seenAt(2, 1)).toBe(true);
    expect(fog.litAt(6, 1)).toBeGreaterThan(0);
  });
});
