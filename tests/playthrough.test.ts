/**
 * Solvability proof: drive the real simulation from spawn to the surface lift.
 *
 * The player is steered with actual directional input along A* paths, so
 * collision, door rules, gate plates, objective preconditions and the escape
 * trigger are all exercised for real — nothing is teleported into place.
 *
 * MIMIC is held away from the route. That is deliberate: this test answers "is
 * the puzzle chain solvable", not "can you evade the hunter". MIMIC can cost you
 * ECHOs and stability, but it can never remove objective progress (objectives
 * are permanent across catches and Temporal Collapse), so it changes how long a
 * win takes, not whether one exists.
 */
import { describe, expect, it } from "vitest";
import { MIMIC, STABILITY, TICK_DT } from "../src/core/constants";
import { dist } from "../src/core/math";
import { Game } from "../src/game/game";
import { findPath } from "../src/systems/pathfind";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

/** Somewhere walkable and far from every plate and objective. */
const MIMIC_PARK = tileCenter(63, 43);

function park(game: Game): void {
  game.mimic.reset(MIMIC_PARK.x, MIMIC_PARK.y);
}

function clearInput(input: FakeInput): void {
  input.state.up = false;
  input.state.down = false;
  input.state.left = false;
  input.state.right = false;
}

/** One tick with MIMIC pinned out of the way. */
function step(game: Game, input: FakeInput): void {
  park(game);
  game.tick(TICK_DT, input.asInput());
}

/** Idle in place for a while, letting ECHOs advance. */
function idle(game: Game, input: FakeInput, seconds: number): void {
  clearInput(input);
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) step(game, input);
}

/** Wait for a condition (typically "the ECHO reached its plate"). */
function waitUntil(
  game: Game,
  input: FakeInput,
  predicate: () => boolean,
  budgetSeconds = 90,
): boolean {
  clearInput(input);
  for (let i = 0; i < Math.round(budgetSeconds / TICK_DT); i++) {
    if (predicate()) return true;
    step(game, input);
  }
  return predicate();
}

/** Steer to a tile along a real path, using real movement input. */
function walkTo(game: Game, tx: number, ty: number, input: FakeInput, budgetSeconds = 90): boolean {
  const goal = tileCenter(tx, ty);
  let path: { x: number; y: number }[] = [];
  let repath = 0;

  for (let i = 0; i < Math.round(budgetSeconds / TICK_DT); i++) {
    const p = game.player;
    if (dist(p.x, p.y, goal.x, goal.y) < 5) {
      clearInput(input);
      return true;
    }
    if (repath <= 0 || path.length === 0) {
      path = findPath(game.level, p.x, p.y, goal.x, goal.y) ?? [];
      repath = 15;
    }
    repath--;
    while (path.length > 0 && dist(p.x, p.y, path[0].x, path[0].y) < 5) path.shift();

    const wp = path[0] ?? goal;
    input.state.left = wp.x < p.x - 1;
    input.state.right = wp.x > p.x + 1;
    input.state.up = wp.y < p.y - 1;
    input.state.down = wp.y > p.y + 1;
    step(game, input);
  }
  clearInput(input);
  return dist(game.player.x, game.player.y, goal.x, goal.y) < 5;
}

function walkToProp(game: Game, propId: string, input: FakeInput): boolean {
  const p = game.level.propById.get(propId)!;
  return walkTo(game, p.tx, p.ty, input);
}

/** Hold R until the run banks as an ECHO. */
function retrace(game: Game, input: FakeInput): void {
  clearInput(input);
  const before = game.run;
  input.hold("KeyR");
  for (let i = 0; i < 120 && game.run === before; i++) step(game, input);
  input.release("KeyR");
  expect(game.run).toBe(before + 1);
}

function useProp(game: Game, propId: string, input: FakeInput): void {
  expect(walkToProp(game, propId, input), `walk to ${propId}`).toBe(true);
  input.press("KeyE");
  step(game, input);
}

/** Record a run that parks the player on `plateId`, then bank it. */
function recordPlateHold(game: Game, plateId: string, input: FakeInput): void {
  expect(walkToProp(game, plateId, input)).toBe(true);
  idle(game, input, 0.5);
  expect(game.level.propById.get(plateId)!.active).toBe(true);
  retrace(game, input);
}

/**
 * Record a run spent standing on a tile, then bank it.
 *
 * The idle before retracing is the important part and is easy to get wrong: an
 * ECHO holds a pad for exactly as long as you stood on it. Record a two-second
 * visit and your past self gives you a two-second window to do your half of the
 * job. Standing there a while is what buys a workable one.
 */
function recordHoldAt(
  game: Game,
  tx: number,
  ty: number,
  input: FakeInput,
  holdSeconds = 9,
): void {
  expect(walkTo(game, tx, ty, input), `walk to ${tx},${ty} to record a hold`).toBe(true);
  idle(game, input, holdSeconds);
  retrace(game, input);
}

const signalHigh = (game: Game, id: string): boolean => game.puzzles.bus.isHigh(id);

const plateActive = (game: Game, id: string): boolean =>
  game.level.propById.get(id)!.active;


/**
 * Walks MIMIC through the containment arch.
 *
 * This is the lure, performed directly. In play the player pulls MIMIC here with
 * noise or an ECHO; these tests hold MIMIC away from the route on purpose, so
 * the lure is simulated rather than left to its patrol.
 */
function earnClearance(game: Game, input: FakeInput): void {
  const arch = tileCenter(52, 11);
  for (let i = 0; i < 40; i++) {
    game.mimic.x = arch.x;
    game.mimic.y = arch.y;
    game.tick(TICK_DT, input.asInput());
  }
  expect(game.objectives.has("clearance"), "containment clearance").toBe(true);
}

describe("wing-01 is winnable", () => {
  it("escalates through all three gates and reaches the surface", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    /* -- STAGE 1, INTAKE: one ECHO holds the clamp ------------------------- */

    // The reactor interlock is dead until the generator intake is authorised,
    // and the two keys sit either side of a hatch only the clamp holds open.
    recordHoldAt(game, 15, 19, input, 12);

    // Travel while the past self retraces its own steps, rather than waiting at
    // spawn for it to arrive. An ECHO replays from t=0 and holds the clamp only
    // as long as you stood there, so idling until the pad lights up and *then*
    // setting off spends the entire window on the walk.
    expect(walkToProp(game, "gen_key_a", input), "S1 walk to key alpha").toBe(true);
    expect(waitUntil(game, input, () => signalHigh(game, "gen.clamp"), 45), "S1 echo holds clamp").toBe(true);

    // KEY ALPHA is in the outer chamber; KEY BETA is through the hatch. One
    // body can only reach both because a past self is holding the way open.
    useProp(game, "gen_key_a", input);
    expect(signalHigh(game, "auth.a"), "S1 key alpha window").toBe(true);
    useProp(game, "gen_key_b", input);
    expect(game.objectives.has("intake"), "S1 intake online").toBe(true);

    /* -- GATE ALPHA: one plate, one ECHO ---------------------------------- */

    recordPlateHold(game, "plate_a", input);
    // Two now: the intake clamp's ECHO from stage one, plus this one.
    expect(game.echoes.count).toBe(2);

    // The ECHO replays from t=0, so it takes as long to walk back as you did.
    expect(waitUntil(game, input, () => plateActive(game, "plate_a")), "S2 plate a held").toBe(true);
    expect(game.level.doorById.get("gate_alpha")!.powered, "S2 gate alpha").toBe(true);

    useProp(game, "reactor_lever", input);
    expect(game.objectives.has("power"), "S2 power online").toBe(true);

    /* -- STAGE 3, CASCADE: two clamps loaded while you throw the breaker --- */

    // Three ECHOs, and each one is only recordable because of the one before it:
    // the intake ECHO holds the hatch open so the bus-clamp runs can get into
    // the inner chamber at all. This is the point where the game stops being
    // "leave a helper somewhere" and becomes a plan with an order to it.
    // Bank the current run before recording the cascade.
    //
    // An ECHO replays everything, including the time you spent waiting around,
    // so a recording made at the end of a long run has its past self idling for
    // a minute before it walks anywhere. Starting each of these from a fresh run
    // keeps them tight: spawn, walk to the pad, stand there.
    retrace(game, input);

    recordHoldAt(game, 15, 19, input, 25);
    expect(walkTo(game, 10, 23, input, 140), "reach bus clamp A through the held hatch").toBe(
      true,
    );
    idle(game, input, 20);
    retrace(game, input);

    expect(walkTo(game, 13, 23, input, 140), "reach bus clamp B").toBe(true);
    idle(game, input, 20);
    retrace(game, input);
    expect(game.echoes.count).toBe(3);

    // Both buses loaded by past selves; the living player throws the breaker.
    expect(
      waitUntil(
        game,
        input,
        () => signalHigh(game, "relay.a") && signalHigh(game, "relay.b"),
        140,
      ),
      "both bus clamps loaded by ECHOs at once",
    ).toBe(true);
    expect(walkTo(game, 17, 24, input, 140), "reach the breaker").toBe(true);
    useProp(game, "gen_relay_c", input);
    expect(game.objectives.has("cascade"), "cascade comes online").toBe(true);

    /* -- GATE BETA: two plates, two ECHOs --------------------------------- */

    recordPlateHold(game, "plate_b", input);
    recordPlateHold(game, "plate_c", input);
    expect(game.echoes.count).toBe(3); // plate_a's ECHO is still banked

    expect(
      waitUntil(
        game,
        input,
        () => plateActive(game, "plate_b") && plateActive(game, "plate_c"),
      ),
    ).toBe(true);
    expect(game.level.doorById.get("gate_beta")!.powered).toBe(true);

    useProp(game, "auth_terminal", input);
    expect(game.objectives.has("auth")).toBe(true);

    /* -- STAGE 5, BYPASS: four signatures, three of them recorded ---------- */

    // The peak of the campaign. The containment console will not answer until
    // the facility has logged four instances of Subject 047 standing in four
    // places at the same moment — which is only possible with a full cast.
    retrace(game, input);
    recordHoldAt(game, 49, 3, input, 25);
    recordHoldAt(game, 54, 3, input, 25);
    recordHoldAt(game, 49, 9, input, 25);
    expect(game.echoes.count).toBe(3);

    expect(
      waitUntil(
        game,
        input,
        () =>
          signalHigh(game, "sig.a") && signalHigh(game, "sig.b") && signalHigh(game, "sig.c"),
        140,
      ),
      "three ECHOs on their pads",
    ).toBe(true);

    // And the fourth signature is the one with a pulse.
    expect(walkTo(game, 54, 9, input, 140), "reach the fourth pad").toBe(true);
    expect(waitUntil(game, input, () => game.objectives.has("bypass"), 30)).toBe(true);

    /* -- GATE GAMMA: three plates, the full ECHO cap ----------------------- */

    // Re-recording evicts the oldest ECHO each time — by design, this is the
    // only way to reach three simultaneous holds with a FIFO of three.
    recordPlateHold(game, "plate_d", input);
    recordPlateHold(game, "plate_e", input);
    recordPlateHold(game, "plate_f", input);
    expect(game.echoes.count).toBe(3);

    expect(
      waitUntil(
        game,
        input,
        () =>
          plateActive(game, "plate_d") &&
          plateActive(game, "plate_e") &&
          plateActive(game, "plate_f"),
      ),
    ).toBe(true);
    expect(game.level.doorById.get("gate_gamma")!.powered).toBe(true);

    useProp(game, "containment_console", input);
    expect(game.objectives.has("containment")).toBe(true);

    /* -- CLEARANCE: the only key the player cannot supply themselves -------- */

    earnClearance(game, input);

    /* -- ESCAPE: the bulkhead runs on flags, so no ECHO support is needed -- */

    expect(game.lockdown).toBe(true);
    expect(waitUntil(game, input, () => game.level.doorById.get("gate_omega")!.powered, 10)).toBe(
      true,
    );

    useProp(game, "surface_lift", input);
    expect(game.phase).toBe("escaped");
    expect(game.memory.data.escapes).toBe(1);
  }, 120_000);

  it("cannot be permanently lost — collapse keeps objectives", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    // Clear the intake stage for real, so this also proves that an objective
    // earned by solving a *puzzle* survives a collapse, not just one earned by
    // flipping a switch.
    recordHoldAt(game, 15, 19, input, 12);
    expect(walkToProp(game, "gen_key_a", input)).toBe(true);
    expect(waitUntil(game, input, () => signalHigh(game, "gen.clamp"), 45)).toBe(true);
    useProp(game, "gen_key_a", input);
    useProp(game, "gen_key_b", input);
    expect(game.objectives.has("intake")).toBe(true);

    // The reactor sits behind GATE ALPHA, so power costs an ECHO before it can
    // be banked at all — there is no shortcut past the first gate.
    recordPlateHold(game, "plate_a", input);
    // Two: the intake clamp ECHO from the stage above, plus this one.
    expect(game.echoes.count).toBe(2);
    expect(waitUntil(game, input, () => plateActive(game, "plate_a"))).toBe(true);

    useProp(game, "reactor_lever", input);
    expect(game.objectives.has("power"), "S2 power online").toBe(true);

    // Take the catches well east along the south corridor — the ECHO replays
    // spawn -> plate_a, and standing in its path means it absorbs the hit
    // instead of the player.
    // Driven from STABILITY.max rather than a literal, and each catch ticks past
    // the respawn grace — MIMIC cannot capture for a beat at the start of a run,
    // so a single tick of contact no longer lands one.
    const away = tileCenter(46, 38);
    for (let i = 0; i < STABILITY.max; i++) {
      game.player.reset(away.x, away.y);
      game.mimic.reset(away.x, away.y);
      let landed = false;
      for (let t = 0; t < Math.ceil(MIMIC.respawnGrace / TICK_DT) + 30; t++) {
        game.player.x = away.x;
        game.player.y = away.y;
        game.mimic.x = away.x;
        game.mimic.y = away.y;
        game.tick(TICK_DT, input.asInput());
        if (game.phase !== "playing") {
          landed = true;
          break;
        }
      }
      expect(landed, `catch ${i + 1} landed`).toBe(true);
      for (let t = 0; t < 400 && game.phase !== "playing"; t++) {
        game.tick(TICK_DT, input.asInput());
      }
      park(game);
    }

    // ECHOs are gone and stability is restored, but the objective survived —
    // so every setback is recoverable and the run can always continue.
    expect(game.echoes.count).toBe(0);
    expect(game.objectives.has("power")).toBe(true);
    // The puzzle-earned stage survives a collapse exactly as the device-earned
    // one does, so no amount of failure can cost the player a solved puzzle.
    expect(game.objectives.has("intake")).toBe(true);
    expect(game.memory.data.collapses).toBe(1);
  }, 120_000);
});

describe("a beginner can finish the short road", () => {
  /**
   * The campaign was cut to three required systems. That cut was verified by
   * granting the objectives directly, which proves the *lift* logic and nothing
   * about whether a person can actually get there. This walks it: real input,
   * real pathing, real recordings, no objective handed over.
   *
   * Six recorded runs, down from twelve. If this ever fails, the game is
   * unfinishable and every other test passing is beside the point.
   */
  it("clears intake, authorization and bypass with real recordings", () => {
    const game = new Game();
    const input = new FakeInput();
    park(game);

    /* -- INTAKE: one ECHO on the clamp ------------------------------------ */

    recordHoldAt(game, 15, 19, input, 12);
    expect(walkToProp(game, "gen_key_a", input)).toBe(true);
    expect(
      waitUntil(game, input, () => signalHigh(game, "gen.clamp"), 45),
      "the past self reaches the clamp",
    ).toBe(true);
    useProp(game, "gen_key_a", input);
    useProp(game, "gen_key_b", input);
    expect(game.objectives.has("intake"), "intake online").toBe(true);

    /* -- AUTHORIZATION: two plates, two ECHOs ----------------------------- */

    recordPlateHold(game, "plate_b", input);
    recordPlateHold(game, "plate_c", input);
    expect(
      waitUntil(
        game,
        input,
        () => plateActive(game, "plate_b") && plateActive(game, "plate_c"),
        90,
      ),
      "both plates held at once",
    ).toBe(true);
    useProp(game, "auth_terminal", input);
    expect(game.objectives.has("auth"), "authorization online").toBe(true);

    /* -- BYPASS: four signatures, three of them recorded ------------------ */

    // Bank the current run first so each recording is a tight spawn-to-pad walk
    // rather than a past self idling through everything that came before.
    retrace(game, input);
    recordHoldAt(game, 49, 3, input, 25);
    recordHoldAt(game, 54, 3, input, 25);
    recordHoldAt(game, 49, 9, input, 25);
    expect(game.echoes.count).toBe(3);

    expect(
      waitUntil(
        game,
        input,
        () =>
          signalHigh(game, "sig.a") && signalHigh(game, "sig.b") && signalHigh(game, "sig.c"),
        140,
      ),
      "three past selves on their pads together",
    ).toBe(true);
    expect(walkTo(game, 54, 9, input, 140)).toBe(true);
    expect(waitUntil(game, input, () => game.objectives.has("bypass"), 30)).toBe(true);

    /* -- CLEARANCE: lure MIMIC through the arch ---------------------------- */

    earnClearance(game, input);

    /* -- THE LIFT --------------------------------------------------------- */

    expect(game.lockdown, "every required system online").toBe(true);
    expect(
      waitUntil(game, input, () => game.level.doorById.get("gate_omega")!.powered, 20),
      "the bulkhead unseals",
    ).toBe(true);

    useProp(game, "surface_lift", input);
    expect(game.phase).toBe("escaped");
    expect(game.memory.data.escapes).toBe(1);

    // The optional stages were genuinely skipped, not quietly required.
    expect(game.objectives.has("power")).toBe(false);
    expect(game.objectives.has("cascade")).toBe(false);
    expect(game.objectives.has("containment")).toBe(false);
  }, 240_000);
});
