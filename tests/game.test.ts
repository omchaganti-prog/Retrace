/**
 * End-to-end acceptance, driven through the real simulation.
 *
 * Covers the brief's puzzle criterion — "Door/puzzle only solves when correct
 * ECHO actions are taken concurrently" — plus the Temporal Stability ladder.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STABILITY, TICK_DT, MIMIC, REQUIRED_OBJECTIVES } from "../src/core/constants";
import { Game } from "../src/game/game";
import { MimicMemory } from "../src/systems/memory";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

/** Somewhere walkable and far from every plate, so it cannot interfere. */
const MIMIC_PARK = tileCenter(63, 43);

beforeAll(() => {
  // No dev server in unit tests; the strategist must fall back silently.
  vi.stubGlobal("fetch", undefined);
});

beforeEach(() => {
  MimicMemory.wipe();
});

function run(game: Game, input: FakeInput, ticks: number): void {
  for (let i = 0; i < ticks; i++) game.tick(TICK_DT, input.asInput());
}

function park(game: Game): void {
  game.mimic.reset(MIMIC_PARK.x, MIMIC_PARK.y);
}

/**
 * Grants the puzzle stages of the campaign.
 *
 * The generator and laboratory stages are proven end to end, with real
 * recordings, in puzzles.test.ts. These tests are about the objective devices
 * and the lift, so they take the puzzle stages as read rather than re-solving
 * them and turning every assertion into a three-ECHO setup.
 */
function grantPuzzleStages(game: Game): void {
  // Every stage that is earned in a puzzle wing rather than at a device. The
  // arch stage in particular needs MIMIC walked into it, which is proven for
  // real in puzzles.test.ts and playthrough.test.ts.
  for (const id of ["intake", "cascade", "bypass", "clearance"] as const) {
    game.objectives.add(id);
  }
}

function standOn(game: Game, propId: string): void {
  const p = game.level.propById.get(propId)!;
  const c = tileCenter(p.tx, p.ty);
  game.player.reset(c.x, c.y);
}

/** Hold R long enough to bank the run as an ECHO. */
function retrace(game: Game, input: FakeInput): void {
  input.hold("KeyR");
  const before = game.run;
  for (let i = 0; i < 90 && game.run === before; i++) {
    game.tick(TICK_DT, input.asInput());
  }
  input.release("KeyR");
  expect(game.run).toBe(before + 1);
}

describe("pressure plates and gates", () => {
  it("opens a one-plate gate while the player stands on it", () => {
    const game = new Game();
    park(game);
    standOn(game, "plate_a");
    run(game, new FakeInput(), 40);

    expect(game.level.propById.get("plate_a")!.active).toBe(true);
    const gate = game.level.doorById.get("gate_alpha")!;
    expect(gate.powered).toBe(true);
    expect(gate.openness).toBeGreaterThan(0.9);
  });

  it("keeps a two-plate gate shut when only one plate is held", () => {
    const game = new Game();
    park(game);
    standOn(game, "plate_b");
    run(game, new FakeInput(), 40);

    expect(game.level.propById.get("plate_b")!.active).toBe(true);
    expect(game.level.doorById.get("gate_beta")!.powered).toBe(false);
  });

  it("lets an ECHO hold the plate after the player has walked away", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    standOn(game, "plate_a");
    run(game, input, 60);
    retrace(game, input);

    // The player is back at spawn; only the recording is on the plate now.
    park(game);
    run(game, input, 40);

    expect(game.echoes.count).toBe(1);
    expect(game.level.propById.get("plate_a")!.weight).toBe(1);
    expect(game.level.doorById.get("gate_alpha")!.powered).toBe(true);
  });

  it("solves the two-plate gate with one ECHO and the live player", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    // Run 1: park on plate_b, then bank it.
    standOn(game, "plate_b");
    run(game, input, 60);
    retrace(game, input);

    // Run 2: the ECHO replays onto plate_b while the player takes plate_c.
    park(game);
    standOn(game, "plate_c");
    run(game, input, 40);

    expect(game.level.propById.get("plate_b")!.active).toBe(true);
    expect(game.level.propById.get("plate_c")!.active).toBe(true);
    expect(game.level.doorById.get("gate_beta")!.powered).toBe(true);
    expect(game.level.doorById.get("gate_beta")!.openness).toBeGreaterThan(0.9);
  });

  it("closes the gate again the moment the ECHO is dissipated", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    standOn(game, "plate_a");
    run(game, input, 60);
    retrace(game, input);
    park(game);
    run(game, input, 30);
    expect(game.level.doorById.get("gate_alpha")!.powered).toBe(true);

    game.echoes.echoes[0].disrupt();
    run(game, input, 10);
    expect(game.level.doorById.get("gate_alpha")!.powered).toBe(false);
  });
});

describe("objectives", () => {
  it("latches an objective when the player uses its device", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    grantPuzzleStages(game);
    standOn(game, "reactor_lever");

    input.press("KeyE");
    run(game, input, 3);

    expect(game.objectives.has("power")).toBe(true);
    expect(game.level.propById.get("reactor_lever")!.active).toBe(true);
    expect(game.nextObjective).toBe("auth");
  });

  it("refuses a device whose prerequisites are unmet", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    standOn(game, "auth_terminal");

    run(game, input, 2);
    expect(game.focusBlocked).toBe(true);

    input.press("KeyE");
    run(game, input, 3);
    expect(game.objectives.has("auth")).toBe(false);
  });

  it("unseals the lift bulkhead only once all three systems are done", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    grantPuzzleStages(game);
    const bulkhead = game.level.doorById.get("gate_omega")!;
    expect(bulkhead.powered).toBe(false);

    for (const id of ["reactor_lever", "auth_terminal", "containment_console"]) {
      standOn(game, id);
      input.press("KeyE");
      run(game, input, 3);
    }

    expect(game.lockdown).toBe(true);
    run(game, input, 40);
    expect(bulkhead.powered).toBe(true);
    expect(game.nextObjective).toBe("escape");
  });

  it("reaches the surface once every system is clear", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    grantPuzzleStages(game);

    for (const id of ["reactor_lever", "auth_terminal", "containment_console"]) {
      standOn(game, id);
      input.press("KeyE");
      run(game, input, 3);
    }

    standOn(game, "surface_lift");
    input.press("KeyE");
    run(game, input, 3);

    expect(game.phase).toBe("escaped");
    expect(game.memory.data.escapes).toBe(1);
  });
});

describe("retrace", () => {
  it("banks a run as an ECHO and never keeps more than three", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    for (let i = 0; i < 5; i++) {
      run(game, input, 30);
      retrace(game, input);
      park(game);
    }
    expect(game.echoes.count).toBe(3);
  });

  it("restarts every ECHO timeline together at the start of a run", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    run(game, input, 40);
    retrace(game, input);
    park(game);
    run(game, input, 40);
    retrace(game, input);
    park(game);

    // Both were rewound by the restart, then advanced by the same tick count.
    const ticks = game.echoes.echoes.map((e) => e.tick);
    expect(new Set(ticks).size).toBe(1);
  });
});

describe("temporal stability", () => {
  function forceCatch(game: Game, input: FakeInput): void {
    game.mimic.reset(game.player.x, game.player.y);
    // MIMIC is briefly immune-to-catching at the start of every run so a respawn
    // is never a trap. Tick past that grace, otherwise this helper silently
    // stops forcing a catch the moment that timing is tuned.
    for (let i = 0; i < Math.ceil(MIMIC.respawnGrace / TICK_DT) + 8; i++) {
      // Pin the position directly. Calling reset() here would re-arm the
      // respawn grace every tick and the catch could never land.
      game.mimic.x = game.player.x;
      game.mimic.y = game.player.y;
      game.tick(TICK_DT, input.asInput());
      // Stop at the first contact of any kind. An ECHO standing on the player
      // absorbs the hit and stalls MIMIC — continuing past that would grind on
      // until the player was caught anyway, which is not what "force a catch"
      // means for the tests that check an ECHO shielded them.
      if (game.phase !== "playing" || game.mimic.stalled) return;
    }
  }

  function waitOutFreeze(game: Game, input: FakeInput): void {
    for (let i = 0; i < 400 && game.phase !== "playing"; i++) {
      game.tick(TICK_DT, input.asInput());
    }
  }

  it("costs a stability point per capture without creating an ECHO", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    run(game, input, 30);

    forceCatch(game, input);
    expect(game.phase).toBe("caught");
    expect(game.stability).toBe(STABILITY.max - 1);

    waitOutFreeze(game, input);
    expect(game.phase).toBe("playing");
    // A capture is strictly worse than retracing — that is the whole tension.
    expect(game.echoes.count).toBe(0);
    expect(game.glitch).toBeGreaterThan(0);
  });

  it("lets an ECHO take the hit instead of the player", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    // Bank a recording of the player standing exactly where they respawn, so
    // the ECHO replays on top of them.
    run(game, input, 30);
    retrace(game, input);
    park(game);
    run(game, input, 5);
    expect(game.echoes.count).toBe(1);

    forceCatch(game, input);

    // MIMIC dissipates the ECHO and stalls; the player keeps their stability.
    expect(game.stability).toBe(STABILITY.max);
    expect(game.phase).toBe("playing");
    expect(game.echoes.echoes[0].phase).toBe("disrupted");
    expect(game.mimic.stalled).toBe(true);
  });

  it("collapses the timeline on the third capture", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    run(game, input, 30);
    retrace(game, input);
    park(game);
    expect(game.echoes.count).toBe(1);

    grantPuzzleStages(game);
    standOn(game, "reactor_lever");
    input.press("KeyE");
    run(game, input, 3);
    expect(game.objectives.has("power")).toBe(true);

    // Away from the banked ECHO, which is parked on the player spawn and would
    // otherwise absorb the contact itself.
    for (let i = 0; i < STABILITY.max - 1; i++) {
      standOn(game, "plate_c");
      forceCatch(game, input);
      waitOutFreeze(game, input);
      park(game);
    }
    expect(game.stability).toBe(1);

    standOn(game, "plate_c");
    forceCatch(game, input);
    expect(game.phase).toBe("collapse");
    waitOutFreeze(game, input);

    expect(game.stability).toBe(STABILITY.max);
    expect(game.echoes.count).toBe(0);
    // Permanent progress survives; MIMIC's knowledge only decays.
    expect(game.objectives.has("power")).toBe(true);
    expect(game.memory.data.collapses).toBe(1);
    expect(game.memory.knowledge()).toBeGreaterThan(0);
  });
});

describe("mimic reactions", () => {
  it("stays on local planning when no strategist endpoint exists", () => {
    const game = new Game();
    expect(game.strategist.link).toBe("local");
    expect(game.strategist.current.source).toBe("local");
    expect(game.strategist.current.patrolZones.length).toBeGreaterThan(0);
  });

  it("investigates a noise it hears out of sight", () => {
    const game = new Game();
    const input = new FakeInput();
    const spot = tileCenter(30, 15);
    game.mimic.reset(spot.x, spot.y);
    // Behind it, out of the cone, but comfortably within earshot.
    game.player.reset(spot.x - 40, spot.y);

    input.state.left = true;
    input.state.sprint = true;
    run(game, input, 60);

    expect(["alert", "chase", "investigate"]).toContain(game.mimic.state);
  });

  it("logs the routes taken during a run into its memory", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    run(game, input, 30);
    retrace(game, input);

    expect(Object.keys(game.memory.data.routeCounts).length).toBeGreaterThan(0);
    expect(game.memory.data.runs).toBeGreaterThan(0);
  });
});

describe("cameras and concealment", () => {
  /** Walks the camera's sweep so the test never depends on its phase. */
  function sweepUntilSeen(game: Game, input: FakeInput): boolean {
    for (let i = 0; i < 60 * 12; i++) {
      game.tick(TICK_DT, input.asInput());
      park(game);
      if (game.level.propById.get("cam_south")!.alertT > 0) return true;
    }
    return false;
  }

  it("relays your position when you stand in a lit part of its cone", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    // Directly in front of the south camera, on open corridor floor.
    const c = tileCenter(38, 37);
    game.player.reset(c.x, c.y);

    expect(sweepUntilSeen(game, input)).toBe(true);
  });

  it("cannot see you inside an unlit alcove", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);
    // The south-corridor alcove, well within the same camera's range.
    const spot = game.level.hideSpots.find((h) => h.id === "hide_south_bend")!;
    const c = tileCenter(spot.tx, spot.ty);
    game.player.reset(c.x, c.y);

    // A full sweep and then some: the lens never gets a look at you.
    expect(sweepUntilSeen(game, input)).toBe(false);
  });
});

describe("the short road", () => {
  /**
   * The campaign was cut from seven required stages to three plus the lift,
   * because twelve recorded runs of setup was too much before any thinking
   * happened. These tests hold that cut honest: the required chain must be
   * completable on its own, and nothing on it may depend on a stage that is now
   * optional — an optional prerequisite in the middle of the critical path is
   * just the long road wearing a disguise.
   */
  it("opens the lift on the required systems alone", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    for (const id of REQUIRED_OBJECTIVES) game.objectives.add(id);

    expect(game.lockdown).toBe(true);
    expect(game.nextObjective).toBe("escape");
    run(game, input, 60);
    expect(game.level.doorById.get("gate_omega")!.powered).toBe(true);

    standOn(game, "surface_lift");
    input.press("KeyE");
    run(game, input, 3);
    expect(game.phase).toBe("escaped");
  });

  it("never puts an optional stage in front of a required one", () => {
    const game = new Game();
    const required = new Set<string>(REQUIRED_OBJECTIVES);
    for (const p of game.level.props) {
      if (!p.objective || !required.has(p.objective)) continue;
      for (const need of p.requires ?? []) {
        expect(
          required.has(need),
          `${p.id} is required but waits on optional "${need}"`,
        ).toBe(true);
      }
    }
  });

  it("leaves the optional stages fully playable", () => {
    // Cut from the critical path, not deleted — the devices still work and
    // still complete their objectives for anyone who wants the whole facility.
    const game = new Game();
    const input = new FakeInput();
    park(game);
    game.objectives.add("intake");

    standOn(game, "reactor_lever");
    input.press("KeyE");
    run(game, input, 3);
    expect(game.objectives.has("power")).toBe(true);
  });
});

describe("the lift and the checklist agree", () => {
  it("gates the bulkhead on exactly the required systems", () => {
    // These two lists live in different files and drifted apart the moment the
    // campaign was shortened: the checklist wanted three systems while the
    // bulkhead still waited on the old set, which is an unwinnable run with no
    // explanation on screen. Neither may change without the other.
    const game = new Game();
    const rule = game.level.doorById.get("gate_omega")!.rule;
    expect(rule.kind).toBe("flags");
    if (rule.kind !== "flags") return;

    const required = [...REQUIRED_OBJECTIVES];
    expect([...rule.flags].sort()).toEqual([...required].sort());

    // And satisfying exactly that set really does open it.
    for (const id of REQUIRED_OBJECTIVES) game.objectives.add(id);
    expect(game.lockdown).toBe(true);
  });
});
