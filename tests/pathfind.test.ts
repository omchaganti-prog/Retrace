/** MIMIC must round corners, and must not walk through a gate you closed. */
import { describe, expect, it } from "vitest";
import { findPath, pathPassable } from "../src/systems/pathfind";
import { Level, tileCenter } from "../src/world/level";
import { WING01 } from "../src/world/wing01";
import { testLevel } from "./helpers";

describe("pathfinding", () => {
  it("routes around a wall instead of through it", () => {
    const level = testLevel();
    const a = tileCenter(2, 1);
    const b = tileCenter(6, 1);
    const path = findPath(level, a.x, a.y, b.x, b.y);

    expect(path).not.toBeNull();
    // The only way across is the corridor on row 3.
    expect(path!.some((p) => Math.floor(p.y / 16) === 3)).toBe(true);
  });

  it("treats an auto hatch as passable and a held gate as solid", () => {
    const auto = testLevel("auto");
    expect(pathPassable(auto, 4, 3)).toBe(true);

    const gate = testLevel("gate");
    const door = gate.doorById.get("door")!;
    door.openness = 0;
    expect(pathPassable(gate, 4, 3)).toBe(false);

    door.openness = 1;
    expect(pathPassable(gate, 4, 3)).toBe(true);
  });

  it("returns null when the target is walled off", () => {
    const gate = testLevel("gate");
    gate.doorById.get("door")!.openness = 0;
    const a = tileCenter(2, 1);
    const b = tileCenter(6, 1);
    expect(findPath(gate, a.x, a.y, b.x, b.y)).toBeNull();
  });

  it("crosses the real wing end to end", () => {
    const level = new Level(WING01);
    const path = findPath(
      level,
      level.playerSpawn.x,
      level.playerSpawn.y,
      level.mimicSpawn.x,
      level.mimicSpawn.y,
    );
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(10);
  });
});

describe("wing-01 layout", () => {
  it("puts every plate, objective and patrol node on walkable ground", () => {
    const level = new Level(WING01);
    for (const p of level.props) {
      expect({ id: p.id, blocked: level.blocksMove(p.tx, p.ty) }).toEqual({
        id: p.id,
        blocked: false,
      });
    }
    for (const n of level.patrolNodes) {
      expect({ id: n.id, blocked: level.blocksMove(n.tx, n.ty) }).toEqual({
        id: n.id,
        blocked: false,
      });
    }
    for (const h of level.hideSpots) {
      expect({ id: h.id, blocked: level.blocksMove(h.tx, h.ty) }).toEqual({
        id: h.id,
        blocked: false,
      });
    }
  });

  it("can reach every plate from the spawn with all gates shut", () => {
    const level = new Level(WING01);
    for (const d of level.doors) d.openness = 0;

    for (const plate of level.props.filter((p) => p.kind === "plate")) {
      const c = tileCenter(plate.tx, plate.ty);
      const path = findPath(level, level.playerSpawn.x, level.playerSpawn.y, c.x, c.y);
      // A plate you cannot reach without first opening the gate it controls
      // would make the wing unsolvable.
      expect({ id: plate.id, reachable: path !== null }).toEqual({
        id: plate.id,
        reachable: true,
      });
    }
  });

  it("assigns every zone referenced by the gates a real centre", () => {
    const level = new Level(WING01);
    for (const z of level.zones) {
      expect({ id: z.id, centre: level.zoneCenter(z.id) !== null }).toEqual({
        id: z.id,
        centre: true,
      });
    }
  });
});
