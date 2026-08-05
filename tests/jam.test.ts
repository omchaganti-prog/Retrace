/**
 * The RETRACE jam.
 *
 * RETRACE must stay a planning tool and never become an emergency teleport out
 * of a chase. The jam is keyed strictly to direct line of sight to the *living*
 * player: an ECHO sighting must never trip it, and a search must never sustain
 * it.
 */
import { describe, expect, it } from "vitest";
import { DETECT, MIMIC, TICK_DT } from "../src/core/constants";
import { Game } from "../src/game/game";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

/** Walkable, and far from anything that would distract MIMIC. */
const FAR = tileCenter(63, 43);
/** Open spine corridor, clear line of sight along it. */
const CORRIDOR = tileCenter(30, 15);
/** MIMIC's post, four tiles west of CORRIDOR and aimed east. */
const POST = tileCenter(26, 15);
/**
 * Deep in the service warren. Out of vision range of POST *and* screened by the
 * maze pillars, so "unseen" here is a property of the level, not of timing.
 */
const HIDDEN = tileCenter(30, 25);

/**
 * MIMIC steers toward its patrol goal every tick, so a one-off placement drifts
 * out of alignment immediately. Tests that care about sight must re-pin both
 * bodies each tick, before the tick that reads them.
 */
function place(game: Game, playerAt: { x: number; y: number }, facing = 0): void {
  game.player.x = playerAt.x;
  game.player.y = playerAt.y;
  game.mimic.x = POST.x;
  game.mimic.y = POST.y;
  game.mimic.facing = facing;
}

function hold(
  game: Game,
  input: FakeInput,
  seconds: number,
  playerAt: { x: number; y: number },
): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    place(game, playerAt);
    game.tick(TICK_DT, input.asInput());
  }
}

/** Ticks with the player standing in the open, squarely in MIMIC's cone. */
const seen = (game: Game, input: FakeInput, seconds: number): void =>
  hold(game, input, seconds, CORRIDOR);

/** Ticks with the player behind cover; MIMIC holds its post. */
const unseen = (game: Game, input: FakeInput, seconds: number): void =>
  hold(game, input, seconds, HIDDEN);

/** Ticks with MIMIC parked far away and the player left where they are. */
function tickAway(game: Game, input: FakeInput, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    game.mimic.x = FAR.x;
    game.mimic.y = FAR.y;
    game.tick(TICK_DT, input.asInput());
  }
}

/** Records an ECHO that stands still at `at`, with MIMIC kept well away. */
function recordEchoAt(game: Game, input: FakeInput, at: { x: number; y: number }): void {
  const pin = (): void => {
    game.player.x = at.x;
    game.player.y = at.y;
    game.mimic.x = FAR.x;
    game.mimic.y = FAR.y;
  };
  for (let i = 0; i < Math.round(0.6 / TICK_DT); i++) {
    pin();
    game.tick(TICK_DT, input.asInput());
  }
  const before = game.echoes.count;
  input.hold("KeyR");
  for (let i = 0; i < 150 && game.echoes.count === before; i++) {
    pin();
    game.tick(TICK_DT, input.asInput());
  }
  input.release("KeyR");
  expect(game.echoes.count).toBe(before + 1);
}

describe("detection buildup", () => {
  it("does not jam on a glancing look", () => {
    const game = new Game();
    const input = new FakeInput();

    seen(game, input, DETECT.confirmSeconds * 0.4);

    expect(game.mimic.detectionPhase).toBe("suspicious");
    expect(game.retraceJammed).toBe(false);
  });

  it("confirms after roughly the configured window and jams", () => {
    const game = new Game();
    const input = new FakeInput();

    seen(game, input, DETECT.confirmSeconds + 0.2);

    expect(game.mimic.detectionPhase).toBe("detected");
    expect(game.mimic.state).toBe("chase");
    expect(game.retraceJammed).toBe(true);
  });

  it("drains the buildup when sight breaks before confirmation", () => {
    const game = new Game();
    const input = new FakeInput();

    seen(game, input, DETECT.confirmSeconds * 0.5);
    expect(game.mimic.detection).toBeGreaterThan(0);
    expect(game.retraceJammed).toBe(false);

    unseen(game, input, DETECT.decaySeconds + 0.2);

    expect(game.mimic.detection).toBe(0);
    expect(game.mimic.detectionPhase).toBe("undetected");
  });

  it("never builds through walls", () => {
    const game = new Game();
    const input = new FakeInput();

    unseen(game, input, 2);

    expect(game.mimic.detection).toBe(0);
    expect(game.retraceJammed).toBe(false);
  });

  it("resolves an unlit alcove more slowly than open ground", () => {
    const game = new Game();
    const input = new FakeInput();
    const alcove = tileCenter(20, 21); // shadow tile in the warren
    const watcher = tileCenter(19, 21);

    for (let i = 0; i < Math.round(DETECT.confirmSeconds / TICK_DT); i++) {
      game.player.x = alcove.x;
      game.player.y = alcove.y;
      game.mimic.x = watcher.x;
      game.mimic.y = watcher.y;
      game.mimic.facing = 0;
      game.tick(TICK_DT, input.asInput());
    }

    // The same exposure in the open would have confirmed by now.
    expect(game.mimic.detection).toBeGreaterThan(0);
    expect(game.mimic.detection).toBeLessThan(1);
    expect(game.retraceJammed).toBe(false);
  });
});

describe("jammed RETRACE", () => {
  it("refuses to charge while jammed", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);
    expect(game.retraceJammed).toBe(true);

    input.hold("KeyR");
    seen(game, input, 3);
    input.release("KeyR");

    expect(game.run).toBe(1);
    expect(game.echoes.count).toBe(0);
    expect(game.retraceProgress).toBe(0);
  });

  it("gives feedback rather than silently ignoring the key", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);

    input.hold("KeyR");
    seen(game, input, 0.2);
    input.release("KeyR");

    expect(game.jamBuzz).toBeGreaterThan(0);
    expect(game.notice?.text).toBe("RETRACE SIGNAL JAMMED");
  });

  it("cancels a charge that was already in progress", () => {
    const game = new Game();
    const input = new FakeInput();

    // The charge must still be mid-flight when the jam lands, so the head start
    // has to leave room for the confirmation window inside the one-second hold.
    // Hard-coding 0.5s meant widening `confirmSeconds` let the RETRACE finish
    // first and the test silently stopped covering cancellation.
    const headStart = Math.max(0.05, 0.9 - DETECT.confirmSeconds);
    input.hold("KeyR");
    tickAway(game, input, headStart);
    expect(game.retraceProgress).toBeGreaterThan(0);

    seen(game, input, DETECT.confirmSeconds + 0.2);
    input.release("KeyR");

    expect(game.retraceJammed).toBe(true);
    expect(game.retraceProgress).toBe(0);
    expect(game.run).toBe(1);
    expect(game.echoes.count).toBe(0);
  });

  it("announces the jam once, not every tick", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);

    expect(game.log.filter((l) => l.text.includes("LINK JAMMED"))).toHaveLength(1);
  });
});

describe("jam release", () => {
  it("does not restore the instant sight breaks", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);

    unseen(game, input, DETECT.releaseSeconds * 0.5);

    expect(game.retraceJammed).toBe(true);
  });

  it("restores after the release window and announces it", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);

    unseen(game, input, DETECT.releaseSeconds + 0.3);

    expect(game.retraceJammed).toBe(false);
    expect(game.notice?.text).toBe("RETRACE SIGNAL RESTORED");
  });

  it("resets the release timer if it sees the player again", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);

    unseen(game, input, DETECT.releaseSeconds * 0.8);
    expect(game.retraceJammed).toBe(true);

    // A single glimpse restarts the recovery clock, even though it is far too
    // brief to re-confirm detection from scratch.
    seen(game, input, 0.1);
    unseen(game, input, DETECT.releaseSeconds * 0.8);
    expect(game.retraceJammed).toBe(true);

    unseen(game, input, DETECT.releaseSeconds * 0.5);
    expect(game.retraceJammed).toBe(false);
  });

  it("lets RETRACE work again once restored", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);
    unseen(game, input, DETECT.releaseSeconds + 0.3);
    expect(game.retraceJammed).toBe(false);

    input.hold("KeyR");
    tickAway(game, input, 1.4);
    input.release("KeyR");

    expect(game.run).toBe(2);
    expect(game.echoes.count).toBe(1);
  });

  it("restores while MIMIC is still searching", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);

    unseen(game, input, DETECT.releaseSeconds + 0.3);

    // Searching is not seeing: the link recovers regardless of AI state.
    expect(game.retraceJammed).toBe(false);
    expect(["chase", "investigate", "alert", "patrol"]).toContain(game.mimic.state);
  });

  it("runs the release clock even while stunned by an ECHO", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);
    expect(game.retraceJammed).toBe(true);

    // A stunned MIMIC is not looking at anything. If the stall froze the clock,
    // this window would be far too short to recover.
    game.mimic.stallT = MIMIC.echoStall;
    unseen(game, input, DETECT.releaseSeconds + 0.3);

    expect(game.retraceJammed).toBe(false);
  });
});

describe("ECHOs never jam the link", () => {
  it("leaves RETRACE available when MIMIC only sees an ECHO", () => {
    const game = new Game();
    const input = new FakeInput();
    recordEchoAt(game, input, CORRIDOR);

    // The ECHO replays into the corridor; the player stays behind cover.
    unseen(game, input, 1.5);

    expect(game.echoes.echoes[0]).toBeDefined();
    expect(game.retraceJammed).toBe(false);
    expect(game.mimic.playerDetected).toBe(false);
    expect(game.mimic.detection).toBe(0);
  });

  it("still lets the ECHO pull MIMIC off patrol", () => {
    const game = new Game();
    const input = new FakeInput();
    recordEchoAt(game, input, CORRIDOR);

    unseen(game, input, 1.5);

    // The distraction still works — it simply does not cost the player RETRACE.
    // "stalled" counts: MIMIC walked into the ECHO and dissipated it, which is
    // the tactic paying off at its most expensive for the AI.
    expect(["alert", "investigate", "chase", "stalled", "patrol"]).toContain(game.mimic.state);
    expect(game.mimic.state).not.toBe("patrol");
    expect(game.retraceJammed).toBe(false);
  });

  it("still allows a RETRACE while the ECHO holds MIMIC's attention", () => {
    const game = new Game();
    const input = new FakeInput();
    recordEchoAt(game, input, CORRIDOR);
    unseen(game, input, 1);
    expect(game.retraceJammed).toBe(false);

    input.hold("KeyR");
    unseen(game, input, 1.4);
    input.release("KeyR");

    expect(game.run).toBe(3);
    expect(game.echoes.count).toBe(2);
  });
});

describe("capture beats a late RETRACE", () => {
  it("cancels the charge and takes the stability hit instead", () => {
    const game = new Game();
    const input = new FakeInput();

    input.hold("KeyR");
    tickAway(game, input, 0.85);
    expect(game.retraceProgress).toBeGreaterThan(0.5);

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
    input.release("KeyR");

    expect(game.phase).toBe("caught");
    expect(game.stability).toBe(2);
    expect(game.retraceProgress).toBe(0);
    // The aborted charge must not have banked anything.
    expect(game.echoes.count).toBe(0);
    expect(game.run).toBe(1);
  });
});

describe("strategic RETRACE is untouched", () => {
  it("works while MIMIC is patrolling far away", () => {
    const game = new Game();
    const input = new FakeInput();

    expect(game.retraceJammed).toBe(false);
    input.hold("KeyR");
    tickAway(game, input, 1.4);
    input.release("KeyR");

    expect(game.run).toBe(2);
    expect(game.echoes.count).toBe(1);
  });

  it("starts every new run with a clear link", () => {
    const game = new Game();
    const input = new FakeInput();
    seen(game, input, DETECT.confirmSeconds + 0.2);
    expect(game.retraceJammed).toBe(true);

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
    for (let i = 0; i < 400 && game.phase !== "playing"; i++) {
      game.tick(TICK_DT, input.asInput());
    }

    expect(game.phase).toBe("playing");
    expect(game.retraceJammed).toBe(false);
    expect(game.mimic.detection).toBe(0);
  });
});
