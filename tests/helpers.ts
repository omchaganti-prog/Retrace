/** Shared fixtures: a tiny hand-checked level and a scriptable Input stand-in. */
import type { Input, InputSnapshot } from "../src/core/input";
import { type LevelDef, Level, r } from "../src/world/level";
import { Tile } from "../src/world/tiles";

/**
 * A 9x5 test map. Row y=3 is a clear corridor; a wall plugs x=4 on rows 1-2, so
 * the only way between the halves of the upper rows is around through y=3.
 *
 *      x: 0123456789
 *   y=0   #########
 *   y=1   #...#...#
 *   y=2   #...#...#
 *   y=3   #.......#     <- corridor (door optionally at x=4)
 *   y=4   #########
 */
export function testLevel(withDoor: "none" | "auto" | "gate" = "none"): Level {
  const def: LevelDef = {
    id: "test",
    name: "TEST",
    w: 9,
    h: 5,
    carve: [
      { area: r(1, 1, 7, 3), tile: Tile.Floor },
      { area: r(4, 1, 4, 2), tile: Tile.Wall },
    ],
    props: [],
    doors:
      withDoor === "none"
        ? []
        : [
            {
              id: "door",
              tx: 4,
              ty: 3,
              rule: withDoor === "auto" ? { kind: "auto" } : { kind: "plates", plates: ["p"] },
            },
          ],
    zones: [{ id: "all", label: "ALL", rects: [r(1, 1, 7, 3)] }],
    playerSpawn: { tx: 1, ty: 3 },
    mimicSpawn: { tx: 7, ty: 3 },
    patrolNodes: [{ id: "a", tx: 1, ty: 3 }],
    hideSpots: [],
  };
  return new Level(def);
}

/** Implements only the surface Game actually reads from Input. */
export class FakeInput {
  readonly state: InputSnapshot = {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    sneak: false,
    dash: false,
  };
  private held = new Set<string>();
  private pressed = new Set<string>();

  hold(code: string): void {
    this.held.add(code);
  }

  release(code: string): void {
    this.held.delete(code);
  }

  press(code: string): void {
    this.pressed.add(code);
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  consumePress(code: string): boolean {
    if (!this.pressed.has(code)) return false;
    this.pressed.delete(code);
    return true;
  }

  /** Game only ever sees the three members above. */
  asInput(): Input {
    return this as unknown as Input;
  }
}
