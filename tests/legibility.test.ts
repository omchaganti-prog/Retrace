/**
 * Plate legibility.
 *
 * A plate's gate is almost always outside the fog radius, so stepping on one
 * produces an effect the player cannot see. Everything here exists to close that
 * loop: the plate names its gate, the gate names its plates, and both report
 * live progress.
 */
import { describe, expect, it } from "vitest";
import { TICK_DT } from "../src/core/constants";
import { Game } from "../src/game/game";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

const FAR = tileCenter(63, 43);

function tick(game: Game, input: FakeInput, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    game.tick(TICK_DT, input.asInput());
  }
}

function standOn(game: Game, propId: string): void {
  const p = game.level.propById.get(propId)!;
  const c = tileCenter(p.tx, p.ty);
  game.player.reset(c.x, c.y);
}

describe("every plate is named and wired", () => {
  it("gives each plate a label", () => {
    const game = new Game();
    for (const p of game.level.props.filter((x) => x.kind === "plate")) {
      expect(p.label, `${p.id} has no label`).toBeTruthy();
    }
  });

  it("maps every plate to the gate it feeds", () => {
    const game = new Game();
    for (const p of game.level.props.filter((x) => x.kind === "plate")) {
      const s = game.plateStatus(p.id);
      expect(s, `${p.id} feeds no gate`).not.toBeNull();
      expect(s!.needed).toBeGreaterThan(0);
    }
  });

  it("reports the gate's requirement, not just the plate's own state", () => {
    const game = new Game();
    // plate_d belongs to the three-plate gate, so it must say 3 even when it is
    // the only one held — that is how you learn two more exist.
    const s = game.plateStatus("plate_d")!;
    expect(s.needed).toBe(3);
    expect(s.label).toBe("GATE GAMMA");
  });
});

describe("standing on a plate explains itself", () => {
  it("names the plate and its gate's progress", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    standOn(game, "plate_b");
    tick(game, input, 0.3);

    expect(game.statusLine).toContain("PLATE B");
    expect(game.statusLine).toContain("GATE BETA");
    expect(game.statusLine).toContain("1/2");
  });

  it("logs the gate — not the plate — when one engages", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    standOn(game, "plate_a");
    tick(game, input, 0.3);

    const line = game.log.find((l) => l.text.includes("PLATE A"));
    expect(line).toBeDefined();
    // The gate is far outside the fog radius, so its name and count are the
    // only cause-and-effect available.
    expect(line!.text).toContain("GATE ALPHA");
    expect(line!.text).toContain("1/1");
  });

  it("counts siblings so partial progress is visible from any one plate", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);

    // Bank an ECHO holding plate_b, then stand on plate_c.
    standOn(game, "plate_b");
    tick(game, input, 0.6);
    input.hold("KeyR");
    for (let i = 0; i < 150 && game.run === 1; i++) {
      game.mimic.reset(FAR.x, FAR.y);
      game.tick(TICK_DT, input.asInput());
    }
    input.release("KeyR");

    standOn(game, "plate_c");
    for (let i = 0; i < 300; i++) {
      game.mimic.reset(FAR.x, FAR.y);
      standOn(game, "plate_c");
      game.tick(TICK_DT, input.asInput());
      if (game.plateStatus("plate_c")!.held === 2) break;
    }

    expect(game.plateStatus("plate_c")!.held).toBe(2);
    expect(game.statusLine).toContain("2/2");
  });

  it("does not offer plates as an [E] prompt", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    standOn(game, "plate_a");
    tick(game, input, 0.3);

    // Plates respond to weight, not to a keypress.
    expect(game.focusProp?.kind).not.toBe("plate");
  });
});

describe("standing at a gate explains what it wants", () => {
  it("names the plates a locked gate is waiting on", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    const gate = game.level.doorById.get("gate_gamma")!;
    const c = tileCenter(gate.tx, gate.ty);
    game.player.reset(c.x, c.y);
    tick(game, input, 0.3);

    expect(game.statusLine).toContain("GATE GAMMA");
    expect(game.statusLine).toContain("0/3");
    expect(game.statusLine).toContain("D");
    expect(game.statusLine).toContain("E");
    expect(game.statusLine).toContain("F");
  });

  it("reports the lift bulkhead in systems, not plates", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    const gate = game.level.doorById.get("gate_omega")!;
    const c = tileCenter(gate.tx, gate.ty);
    game.player.reset(c.x, c.y);
    tick(game, input, 0.3);

    expect(game.statusLine).toContain("0/3 SYSTEMS");
  });
});

describe("the schematic terminal", () => {
  it("sits within reach of the spawn", () => {
    const game = new Game();
    const p = game.level.propById.get("wiring_schematic");
    expect(p).toBeDefined();
    const c = tileCenter(p!.tx, p!.ty);
    const spawn = game.level.playerSpawn;
    expect(Math.hypot(c.x - spawn.x, c.y - spawn.y)).toBeLessThan(16 * 6);
  });

  it("prints the whole wiring, generated from the level itself", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    standOn(game, "wiring_schematic");
    input.press("KeyE");
    tick(game, input, 0.2);

    expect(game.schematic).not.toBeNull();
    const all = game.schematic!.lines.join("\n");
    expect(all).toContain("GATE ALPHA <- PLATE A");
    expect(all).toContain("GATE BETA <- PLATE B + PLATE C");
    expect(all).toContain("GATE GAMMA <- PLATE D + PLATE E + PLATE F");
    expect(all).toContain("LIFT BULKHEAD");
  });

  it("cannot drift out of sync with the actual door rules", () => {
    const game = new Game();
    for (const d of game.level.doors) {
      if (d.rule.kind !== "plates") continue;
      const line = game.wiringLines().find((l) => l.startsWith(d.label ?? d.id));
      expect(line, `${d.id} missing from schematic`).toBeDefined();
      for (const plateId of d.rule.plates) {
        const label = game.level.propById.get(plateId)!.label!;
        expect(line).toContain(label);
      }
    }
  });

  it("fades on its own", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    standOn(game, "wiring_schematic");
    input.press("KeyE");
    tick(game, input, 0.2);
    expect(game.schematic).not.toBeNull();

    tick(game, input, 13);
    expect(game.schematic).toBeNull();
  });
});

describe("a beginner is told what to do, not just what is happening", () => {
  /**
   * The status line says what the facility is doing. That is necessary and
   * insufficient: a new player standing on a plate reading "GATE BETA NEEDS 1
   * MORE PLATE HELD" still has no idea that recording a run is the answer. The
   * hint line is the sentence that closes that gap, and it must name RETRACE.
   */
  it("nudges toward RETRACE when a gate wants more bodies than exist", () => {
    const game = new Game();
    const input = new FakeInput();
    standOn(game, "plate_b"); // GATE BETA wants two
    tick(game, input, 0.17);

    expect(game.hint).toBeTruthy();
    expect(game.hint!.text).toContain("[R]");
  });

  it("says nothing extra once the gate is satisfied", () => {
    const game = new Game();
    const input = new FakeInput();
    standOn(game, "plate_a"); // GATE ALPHA wants one, and one is held
    tick(game, input, 0.17);

    expect(game.statusLine).toContain("OPEN");
    expect(game.hint).toBeNull();
  });

  it("stops nagging after a few showings", () => {
    const game = new Game();
    const input = new FakeInput();

    // Arrive, leave, arrive again — more times than the hint is allowed.
    for (let i = 0; i < 8; i++) {
      standOn(game, "plate_b");
      tick(game, input, 0.10);
      game.hint = null;
      standOn(game, "plate_e");
      tick(game, input, 0.10);
      game.hint = null;
    }
    standOn(game, "plate_b");
    tick(game, input, 0.10);
    // A hint that repeats forever becomes furniture the player stops reading.
    expect(game.hint).toBeNull();
  });
});
