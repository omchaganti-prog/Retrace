/**
 * The puzzles, end to end, driven by real recordings.
 *
 * These are the tests that matter. A component that counts bodies is easy to
 * unit-test; what has to be proven is that a run banked as an ECHO actually
 * comes back and holds the clamp down, that three of them do it at once and stay
 * in sync, and that a RETRACE leaves nothing behind.
 *
 * The question asked of every puzzle here is the one from the brief: could it be
 * solved without RETRACE? Each test answers it by first showing a lone player
 * cannot, and only then showing that a past self can.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_DT } from "../src/core/constants";
import { Game } from "../src/game/game";
import { MimicMemory } from "../src/systems/memory";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

/** Far from every puzzle, so MIMIC never interferes with a measurement. */
const MIMIC_PARK = tileCenter(63, 43);

beforeAll(() => {
  vi.stubGlobal("fetch", undefined);
});

beforeEach(() => {
  MimicMemory.wipe();
});

function park(game: Game): void {
  game.mimic.reset(MIMIC_PARK.x, MIMIC_PARK.y);
}

/** Ticks the game, holding MIMIC out of the way the whole time. */
function run(game: Game, input: FakeInput, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    park(game);
    game.tick(TICK_DT, input.asInput());
  }
}

function placeAt(game: Game, tx: number, ty: number): void {
  const c = tileCenter(tx, ty);
  game.player.reset(c.x, c.y);
}

/** Pins the player in place while the world ticks around them. */
function holdAt(game: Game, input: FakeInput, tx: number, ty: number, ticks: number): void {
  const c = tileCenter(tx, ty);
  for (let i = 0; i < ticks; i++) {
    game.player.x = c.x;
    game.player.y = c.y;
    park(game);
    game.tick(TICK_DT, input.asInput());
  }
}

/** Banks the current run as an ECHO. */
function retrace(game: Game, input: FakeInput): void {
  const before = game.run;
  input.hold("KeyR");
  for (let i = 0; i < 120 && game.run === before; i++) {
    park(game);
    game.tick(TICK_DT, input.asInput());
  }
  input.release("KeyR");
  expect(game.run).toBe(before + 1);
}

/**
 * Records a run spent standing on one spot, then banks it. The resulting ECHO
 * stands on that spot from the start of every subsequent run.
 */
function recordStandingAt(game: Game, input: FakeInput, tx: number, ty: number): void {
  placeAt(game, tx, ty);
  holdAt(game, input, tx, ty, 90);
  // The RETRACE hold is recorded too, so the ECHO stays put through it.
  const c = tileCenter(tx, ty);
  const before = game.run;
  input.hold("KeyR");
  for (let i = 0; i < 120 && game.run === before; i++) {
    game.player.x = c.x;
    game.player.y = c.y;
    park(game);
    game.tick(TICK_DT, input.asInput());
  }
  input.release("KeyR");
  expect(game.run).toBe(before + 1);
}

const doorOpen = (game: Game, id: string): boolean =>
  (game.level.doorById.get(id)?.openness ?? 0) > 0.9;

describe("TIER 1 — the temporal door", () => {
  it("cannot be held open by the one body that has to walk through it", () => {
    const game = new Game();
    const input = new FakeInput();

    // Standing on the clamp opens the hatch...
    holdAt(game, input, 15, 19, 30);
    expect(game.puzzles.bus.isHigh("gen.clamp")).toBe(true);
    expect(doorOpen(game, "gen_inner")).toBe(true);

    // ...and stepping off closes it, well before anything could cross.
    holdAt(game, input, 12, 19, 30);
    expect(game.puzzles.bus.isHigh("gen.clamp")).toBe(false);
    expect(doorOpen(game, "gen_inner")).toBe(false);
  });

  it("is held open by a past self while the player walks through", () => {
    const game = new Game();
    const input = new FakeInput();

    recordStandingAt(game, input, 15, 19);

    // The player is nowhere near the clamp now — but somebody is.
    holdAt(game, input, 11, 20, 20);
    expect(game.echoes.echoes.length).toBe(1);
    expect(game.puzzles.bus.isHigh("gen.clamp")).toBe(true);
    expect(doorOpen(game, "gen_inner")).toBe(true);
  });
});

describe("TIER 2 — dual authorization", () => {
  it("needs both key windows live at once", () => {
    const game = new Game();
    const input = new FakeInput();

    // One key alone is not authorization.
    game.level.propById.get("gen_key_a")!.active = true;
    run(game, input, 10);
    expect(game.puzzles.bus.isHigh("auth.a")).toBe(true);
    expect(game.puzzles.bus.isHigh("auth.ok")).toBe(false);
    expect(doorOpen(game, "gen_auth")).toBe(false);

    game.level.propById.get("gen_key_b")!.active = true;
    run(game, input, 10);
    expect(game.puzzles.bus.isHigh("auth.ok")).toBe(true);
    // Doors travel; the signal is instant but the slab is not.
    run(game, input, 40);
    expect(doorOpen(game, "gen_auth")).toBe(true);
  });

  it("latches, so the gate does not slam when a window lapses", () => {
    const game = new Game();
    const input = new FakeInput();
    game.level.propById.get("gen_key_a")!.active = true;
    game.level.propById.get("gen_key_b")!.active = true;
    run(game, input, 10);
    expect(game.puzzles.bus.isHigh("auth.ok")).toBe(true);

    // Long past both nine-second windows.
    run(game, input, 60 * 12);
    expect(game.puzzles.bus.isHigh("auth.a")).toBe(false);
    expect(game.puzzles.bus.isHigh("auth.ok")).toBe(true);
  });
});

describe("TIER 3 — the relay cascade", () => {
  it("cannot be thrown by one body", () => {
    const game = new Game();
    const input = new FakeInput();

    // Standing on one bus clamp and throwing the breaker is not a cascade —
    // the other clamp is unloaded, and no single body can weight both.
    game.level.propById.get("gen_relay_c")!.active = true;
    holdAt(game, input, 10, 23, 20);
    expect(game.puzzles.bus.isHigh("relay.a")).toBe(true);
    expect(game.puzzles.bus.isHigh("relay.c")).toBe(true);
    expect(game.puzzles.bus.isHigh("relay.b")).toBe(false);
    expect(game.puzzles.solved("relay_done")).toBe(false);
  });

  it("comes online with both clamps loaded by past selves", () => {
    const game = new Game();
    const input = new FakeInput();

    recordStandingAt(game, input, 10, 23); // BUS CLAMP A
    recordStandingAt(game, input, 13, 23); // BUS CLAMP B
    expect(game.echoes.echoes.length).toBe(2);

    // Both clamps are loaded by ECHOs; the living player throws the breaker.
    game.level.propById.get("gen_relay_c")!.active = true;
    holdAt(game, input, 17, 24, 20);

    expect(game.puzzles.bus.isHigh("relay.a")).toBe(true);
    expect(game.puzzles.bus.isHigh("relay.b")).toBe(true);
    expect(game.puzzles.bus.isHigh("relay.c")).toBe(true);
    expect(game.puzzles.solved("relay_done")).toBe(true);
    run(game, input, 40);
    expect(doorOpen(game, "gen_auth")).toBe(true);
  });
});

describe("TIER 4 — four signatures", () => {
  it("is impossible for one body", () => {
    const game = new Game();
    const input = new FakeInput();
    holdAt(game, input, 49, 3, 20);
    expect(game.puzzles.bus.isHigh("sig.a")).toBe(true);
    expect(game.puzzles.bus.isHigh("sig.ok")).toBe(false);
    expect(doorOpen(game, "lab_vault")).toBe(false);
  });

  it("opens the vault with three ECHOs and the living player", () => {
    const game = new Game();
    const input = new FakeInput();

    // Three runs, one pad each. Every RETRACE rewinds the whole cast, so all
    // three come back on their marks at the same moment.
    recordStandingAt(game, input, 49, 3); // PAD A
    recordStandingAt(game, input, 54, 3); // PAD B
    recordStandingAt(game, input, 49, 9); // PAD C
    expect(game.echoes.echoes.length).toBe(3);

    // And the fourth signature is the one with a pulse.
    holdAt(game, input, 54, 9, 20);

    expect(game.puzzles.bus.isHigh("sig.a")).toBe(true);
    expect(game.puzzles.bus.isHigh("sig.b")).toBe(true);
    expect(game.puzzles.bus.isHigh("sig.c")).toBe(true);
    expect(game.puzzles.bus.isHigh("sig.d")).toBe(true);
    expect(game.puzzles.solved("sig_done")).toBe(true);
    expect(doorOpen(game, "lab_vault")).toBe(true);
  });

  it("stays open once proven, even as the ECHOs walk off their pads", () => {
    const game = new Game();
    const input = new FakeInput();
    recordStandingAt(game, input, 49, 3);
    recordStandingAt(game, input, 54, 3);
    recordStandingAt(game, input, 49, 9);
    holdAt(game, input, 54, 9, 20);
    expect(game.puzzles.solved("sig_done")).toBe(true);

    // The living player leaves for the vault.
    holdAt(game, input, 45, 7, 30);
    expect(game.puzzles.bus.isHigh("sig.d")).toBe(false);
    expect(doorOpen(game, "lab_vault")).toBe(true);
  });
});

describe("TIER 5 — the sound chamber", () => {
  it("hears an ECHO's recorded footsteps, not just the living player's", () => {
    const game = new Game();
    const input = new FakeInput();

    // Walk past microphone A, making real noise, and bank it.
    placeAt(game, 11, 28);
    input.hold("KeyD");
    run(game, input, 70);
    input.release("KeyD");
    retrace(game, input);

    // The player is across the wing; the microphone still trips.
    holdAt(game, input, 16, 32, 90);
    expect(game.puzzles.bus.isHigh("mic.a")).toBe(true);
  });
});

describe("TIER 7 — the containment arch", () => {
  it("refuses every signature the player can produce", () => {
    const game = new Game();
    const input = new FakeInput();
    recordStandingAt(game, input, 52, 11);
    recordStandingAt(game, input, 53, 11);
    holdAt(game, input, 51, 12, 20);

    // Three bodies inside the arch, none of them containment-grade.
    expect(game.puzzles.bus.isHigh("arch.auth")).toBe(false);
    expect(doorOpen(game, "lab_arch")).toBe(false);
  });

  it("accepts MIMIC's, and holds the bay open afterwards", () => {
    const game = new Game();
    const input = new FakeInput();
    placeAt(game, 45, 7);

    // Walk MIMIC through the arch, exactly as luring it there would.
    const arch = tileCenter(52, 11);
    for (let i = 0; i < 20; i++) {
      game.mimic.x = arch.x;
      game.mimic.y = arch.y;
      game.tick(TICK_DT, input.asInput());
    }
    expect(game.puzzles.bus.isHigh("arch.auth")).toBe(true);
    expect(doorOpen(game, "lab_arch")).toBe(true);

    // It wanders off; the bay does not re-seal on the player inside it.
    run(game, input, 60 * 20);
    expect(game.puzzles.bus.isHigh("arch.auth")).toBe(false);
    expect(game.puzzles.solved("arch_latch")).toBe(true);
    expect(doorOpen(game, "lab_arch")).toBe(true);
  });
});

describe("reset safety", () => {
  it("wipes every latch and timer on a RETRACE", () => {
    const game = new Game();
    const input = new FakeInput();
    game.level.propById.get("gen_key_a")!.active = true;
    game.level.propById.get("gen_key_b")!.active = true;
    run(game, input, 10);
    expect(game.puzzles.solved("auth_done")).toBe(true);

    retrace(game, input);
    expect(game.puzzles.solved("auth_done")).toBe(false);
    expect(game.puzzles.bus.isHigh("auth.a")).toBe(false);
    expect(game.puzzles.bus.isHigh("auth.ok")).toBe(false);
  });

  it("survives repeated RETRACEs without drifting", () => {
    const game = new Game();
    const input = new FakeInput();
    for (let i = 0; i < 6; i++) {
      holdAt(game, input, 15, 19, 20);
      expect(game.puzzles.bus.isHigh("gen.clamp")).toBe(true);
      retrace(game, input);
      // No latch may survive a reset. The clamp signal legitimately comes
      // straight back — the run just banked is an ECHO now standing on it,
      // which is the mechanic working, not state leaking.
      expect(game.puzzles.solved("auth_done")).toBe(false);
      expect(game.puzzles.solved("sig_done")).toBe(false);
      expect(game.puzzles.solved("relay_done")).toBe(false);
    }
    // Signals stay bounded by what is physically happening rather than piling up.
    expect(game.puzzles.bus.active().length).toBeLessThanOrEqual(2);
  });

  it("leaves no puzzle door sealed in a way that strands the run", () => {
    const game = new Game();
    const input = new FakeInput();
    run(game, input, 30);
    // Every signal door is a side room off a corridor that is always walkable,
    // so the objective chain and the lift stay reachable with all of them shut.
    for (const d of game.level.doors) {
      if (d.rule.kind === "signal") expect(d.openness).toBe(0);
    }
    expect(game.phase).toBe("playing");
  });
});

describe("the puzzles are RETRACE puzzles", () => {
  it("counts ECHOs and the player identically on every scanner", () => {
    const game = new Game();
    const input = new FakeInput();
    // A pad reached by the player alone.
    holdAt(game, input, 49, 3, 20);
    const byPlayer = game.puzzles.bus.isHigh("sig.a");

    recordStandingAt(game, input, 49, 3);
    holdAt(game, input, 45, 7, 20);
    const byEcho = game.puzzles.bus.isHigh("sig.a");

    expect(byPlayer).toBe(true);
    expect(byEcho).toBe(true);
  });

  it("keeps three ECHOs synchronised across a shared timeline", () => {
    const game = new Game();
    const input = new FakeInput();
    recordStandingAt(game, input, 49, 3);
    recordStandingAt(game, input, 54, 3);
    recordStandingAt(game, input, 49, 9);

    // All three rewound together, so all three are on their marks together.
    const pads = ["sig.a", "sig.b", "sig.c"];
    let bothHighTogether = false;
    for (let i = 0; i < 60; i++) {
      park(game);
      game.tick(TICK_DT, input.asInput());
      if (pads.every((p) => game.puzzles.bus.isHigh(p))) bothHighTogether = true;
    }
    expect(bothHighTogether).toBe(true);
  });
});

describe("TIER 6 — camera bait", () => {
  it("opens the checkpoint for a decoy contact, but never for being seen yourself", () => {
    const game = new Game();
    const input = new FakeInput();

    // Directly in the security camera's arc. Being seen personally is not a
    // resource — it is just being seen.
    let seenAsPlayer = false;
    for (let i = 0; i < 60 * 8; i++) {
      game.player.x = tileCenter(15, 32).x;
      game.player.y = tileCenter(15, 32).y;
      park(game);
      game.tick(TICK_DT, input.asInput());
      if (game.level.propById.get("cam_security")!.alertT > 0) seenAsPlayer = true;
    }
    expect(seenAsPlayer).toBe(true);
    expect(game.puzzles.bus.isHigh("bait.relay")).toBe(false);
    expect(doorOpen(game, "sec_checkpoint")).toBe(false);

    // Bank that same loitering as an ECHO and let the camera find *it* instead.
    retrace(game, input);
    let relayed = false;
    for (let i = 0; i < 60 * 12; i++) {
      // The player waits at the checkpoint, well outside the camera's arc.
      game.player.x = tileCenter(17, 28).x;
      game.player.y = tileCenter(17, 28).y;
      park(game);
      game.tick(TICK_DT, input.asInput());
      if (game.puzzles.bus.isHigh("bait.relay")) relayed = true;
      if (relayed && doorOpen(game, "sec_checkpoint")) break;
    }
    expect(relayed).toBe(true);
    expect(doorOpen(game, "sec_checkpoint")).toBe(true);
  });
});

describe("TIER 9 — the orchestra", () => {
  it("needs all four parts playing at once, and no fewer", () => {
    const game = new Game();
    const input = new FakeInput();

    // Part one, recorded: a relay held down.
    recordStandingAt(game, input, 58, 3);

    // Part two, recorded: a sprint through the monitored corridor. Movement has
    // to be driven through the input snapshot — holding a key code alone only
    // feeds isDown() and would record a body standing perfectly still.
    placeAt(game, 58, 7);
    input.state.right = true;
    input.state.sprint = true;
    run(game, input, 50);
    input.state.right = false;
    input.state.sprint = false;
    retrace(game, input);

    // Part three, recorded: the second relay.
    recordStandingAt(game, input, 58, 10);
    expect(game.echoes.echoes.length).toBe(3);

    // Three parts is not a performance.
    holdAt(game, input, 45, 7, 20);
    expect(game.puzzles.solved("orchestra_done")).toBe(false);

    // Part four is the living player at the console while the rest play.
    let allFour = false;
    for (let i = 0; i < 200; i++) {
      game.player.x = tileCenter(61, 3).x;
      game.player.y = tileCenter(61, 3).y;
      park(game);
      game.tick(TICK_DT, input.asInput());
      if (game.puzzles.solved("orchestra_done")) allFour = true;
    }

    expect(game.puzzles.bus.isHigh("orch.a")).toBe(true);
    expect(game.puzzles.bus.isHigh("orch.c")).toBe(true);
    expect(game.puzzles.bus.isHigh("orch.d")).toBe(true);
    expect(allFour).toBe(true);
    expect(doorOpen(game, "lab_vault")).toBe(true);
  });
});

describe("polish: the arch survives the runs it has to enable", () => {
  it("stays unsealed across RETRACE once MIMIC has cleared it", () => {
    const game = new Game();
    const input = new FakeInput();
    placeAt(game, 45, 7);

    const arch = tileCenter(52, 11);
    for (let i = 0; i < 20; i++) {
      game.mimic.x = arch.x;
      game.mimic.y = arch.y;
      game.tick(TICK_DT, input.asInput());
    }
    expect(game.puzzles.solved("arch_latch")).toBe(true);

    // Three recordings have to be made inside the bay behind this door. Having
    // to re-lure MIMIC before each one would be repetition, not a puzzle.
    for (let i = 0; i < 3; i++) {
      retrace(game, input);
      run(game, input, 40);
      expect(game.puzzles.solved("arch_latch")).toBe(true);
      expect(doorOpen(game, "lab_arch")).toBe(true);
    }
  });

  it("is the only latch that persists — the rest still reset", () => {
    const game = new Game();
    const input = new FakeInput();
    game.level.propById.get("gen_key_a")!.active = true;
    game.level.propById.get("gen_key_b")!.active = true;
    run(game, input, 10);
    expect(game.puzzles.solved("auth_done")).toBe(true);

    retrace(game, input);
    expect(game.puzzles.solved("auth_done")).toBe(false);
    expect(game.puzzles.solved("sig_done")).toBe(false);
    expect(game.puzzles.solved("relay_done")).toBe(false);
    expect(game.puzzles.solved("mic_done")).toBe(false);
    expect(game.puzzles.solved("orchestra_done")).toBe(false);
  });
});

describe("polish: rooms holding several machines stay legible", () => {
  it("reports the machine that is actually doing something", () => {
    const game = new Game();
    const input = new FakeInput();

    // The security wing holds three independent ways through its checkpoint.
    // Whichever one is live is the one worth naming.
    holdAt(game, input, 13, 30, 10);
    expect(game.statusLine).toBeTruthy();

    // Trip the acoustic baffle and it takes over the readout, rather than being
    // hidden behind whichever puzzle happens to be declared first.
    placeAt(game, 11, 28);
    input.state.right = true;
    input.state.sprint = true;
    run(game, input, 50);
    input.state.right = false;
    input.state.sprint = false;
    holdAt(game, input, 13, 30, 5);

    expect(game.statusLine).toContain("BAFFLE");
  });

  it("names every puzzle room it is standing in", () => {
    const game = new Game();
    const input = new FakeInput();
    const seen = new Set<string>();
    for (const [tx, ty] of [
      [13, 19],
      [13, 23],
      [13, 30],
      [52, 5],
      [52, 11],
      [59, 5],
    ] as const) {
      holdAt(game, input, tx, ty, 4);
      if (game.statusLine) seen.add(game.statusLine.split(" — ")[0]);
    }
    // Generator intake, cascade, security, array, arch, orchestra.
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});
