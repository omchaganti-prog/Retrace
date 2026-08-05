/**
 * The reusable puzzle components, in isolation.
 *
 * The property that matters throughout: a component must not be able to tell a
 * living player from an ECHO. Everything RETRACE's puzzle design rests on — a
 * past self holding a clamp, three of you on four pads, a recorded dash tripping
 * a microphone — is downstream of that one rule.
 */
import { describe, expect, it } from "vitest";
import { TILE } from "../src/core/constants";
import {
  type PuzzleBody,
  type PuzzleContext,
  AbilityWindow,
  CameraTap,
  Latch,
  MimicScanner,
  Scanner,
  Sequence,
  SoundSensor,
  TimedSwitch,
} from "../src/puzzle/components";
import { SignalBus } from "../src/puzzle/signals";
import type { SoundKind } from "../src/systems/sound";
import { r } from "../src/world/level";

const DT = 1 / 60;

function ctx(over: Partial<PuzzleContext> = {}): PuzzleContext {
  return {
    dt: DT,
    elapsed: 0,
    bus: new SignalBus(),
    bodies: [],
    mimic: { x: -999, y: -999, state: "patrol", alerted: false },
    heardAt: () => null,
    cameraSaw: () => null,
    abilityOnCooldown: () => false,
    propActive: () => false,
    log: () => {},
    notice: () => {},
    play: () => {},
    ...over,
  };
}

const at = (
  tx: number,
  ty: number,
  kind: PuzzleBody["kind"],
  id: string = kind,
): PuzzleBody => ({
  x: tx * TILE + TILE / 2,
  y: ty * TILE + TILE / 2,
  kind,
  id,
});

/**
 * A stand-in for the sound bus that behaves the way the real one does: the
 * kind filter is applied *before* picking the loudest, not after. A stub that
 * ignores the filter would hide exactly the masking bug this suite exists to
 * catch.
 */
function audibleWorld(
  sounds: { loudness: number; kind: SoundKind }[],
): PuzzleContext["heardAt"] {
  return (_x, _y, kinds) => {
    const eligible = kinds ? sounds.filter((s) => kinds.includes(s.kind)) : sounds;
    let best: { loudness: number; kind: SoundKind } | null = null;
    for (const s of eligible) if (!best || s.loudness > best.loudness) best = s;
    return best ? { loudness: best.loudness, kind: best.kind, source: "echo" } : null;
  };
}

/**
 * Advances a component for `seconds`. The frame is rolled *before* each update,
 * mirroring the game — where doors read the bus after components have written
 * to it and endTick only happens once everyone is done. Rolling it afterwards
 * would wipe the final tick's signals before the assertion could see them.
 */
function run(c: { update(ctx: PuzzleContext): void }, c2: PuzzleContext, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    c2.bus.beginTick();
    c.update(c2);
  }
}

describe("scanner pads", () => {
  const pad = () =>
    new Scanner({ kind: "scanner", id: "p", emits: "sig", label: "PAD", area: r(4, 4, 5, 5) });

  it("cannot tell an ECHO from the living player", () => {
    const byPlayer = ctx({ bodies: [at(4, 4, "player")] });
    const a = pad();
    a.update(byPlayer);
    expect(byPlayer.bus.isHigh("sig")).toBe(true);

    const byEcho = ctx({ bodies: [at(4, 4, "echo", "echo-1")] });
    const b = pad();
    b.update(byEcho);
    expect(byEcho.bus.isHigh("sig")).toBe(true);
  });

  it("ignores bodies outside its footprint", () => {
    const c = ctx({ bodies: [at(9, 9, "player")] });
    const p = pad();
    p.update(c);
    expect(c.bus.isHigh("sig")).toBe(false);
  });

  it("counts the four instances the finale needs", () => {
    const four = new Scanner({
      kind: "scanner",
      id: "p",
      emits: "sig",
      label: "PAD",
      area: r(4, 4, 5, 5),
      need: 4,
    });
    const three = ctx({
      bodies: [at(4, 4, "player"), at(4, 5, "echo", "e1"), at(5, 4, "echo", "e2")],
    });
    three.bus.beginTick();
    four.update(three);
    expect(three.bus.isHigh("sig")).toBe(false);
    expect(four.count).toBe(3);

    const all = ctx({
      bodies: [
        at(4, 4, "player"),
        at(4, 5, "echo", "e1"),
        at(5, 4, "echo", "e2"),
        at(5, 5, "echo", "e3"),
      ],
    });
    const four2 = new Scanner({
      kind: "scanner",
      id: "p",
      emits: "sig",
      label: "PAD",
      area: r(4, 4, 5, 5),
      need: 4,
    });
    four2.update(all);
    expect(all.bus.isHigh("sig")).toBe(true);
  });

  it("can be told to refuse the living player outright", () => {
    const s = new Scanner({
      kind: "scanner",
      id: "p",
      emits: "sig",
      label: "PAD",
      area: r(4, 4, 5, 5),
      echoOnly: true,
    });
    const c = ctx({ bodies: [at(4, 4, "player")] });
    s.update(c);
    expect(c.bus.isHigh("sig")).toBe(false);
  });
});

describe("timed switch", () => {
  it("holds its window then drops", () => {
    const sw = new TimedSwitch({
      kind: "timed",
      id: "s",
      emits: "key",
      label: "KEY",
      propId: "lever",
      seconds: 2,
    });
    const c = ctx({ propActive: () => true });

    sw.update(c);
    expect(c.bus.isHigh("key")).toBe(true);
    run(sw, c, 1.5);
    expect(c.bus.strength("key")).toBeGreaterThan(0);
    run(sw, c, 1.0);
    expect(c.bus.strength("key")).toBe(0);
  });

  it("re-arms when an ECHO re-performs the interaction", () => {
    const sw = new TimedSwitch({
      kind: "timed",
      id: "s",
      emits: "key",
      label: "KEY",
      propId: "lever",
      seconds: 2,
    });
    let on = false;
    const c = ctx({ propActive: () => on });

    on = true;
    sw.update(c);
    c.bus.beginTick();
    on = false;
    run(sw, c, 3);
    expect(c.bus.strength("key")).toBe(0);

    // The rising edge is what arms it, exactly as it did the first time.
    on = true;
    sw.update(c);
    expect(c.bus.isHigh("key")).toBe(true);
  });
});

describe("sound sensor", () => {
  it("is tripped by a recorded noise, whoever made it", () => {
    const mic = new SoundSensor({
      kind: "sound",
      id: "m",
      emits: "mic",
      label: "MIC",
      tx: 3,
      ty: 3,
      threshold: 1,
      holdSeconds: 2,
    });
    const c = ctx({ heardAt: () => ({ loudness: 2, kind: "step", source: "echo" }) });
    mic.update(c);
    expect(c.bus.isHigh("mic")).toBe(true);
  });

  it("ignores anything under its threshold", () => {
    const mic = new SoundSensor({
      kind: "sound",
      id: "m",
      emits: "mic",
      label: "MIC",
      tx: 3,
      ty: 3,
      threshold: 2,
    });
    const c = ctx({ heardAt: () => ({ loudness: 0.4, kind: "step", source: "player" }) });
    mic.update(c);
    expect(c.bus.isHigh("mic")).toBe(false);
  });

  it("can demand an impulse rather than footsteps", () => {
    const make = () =>
      new SoundSensor({
        kind: "sound",
        id: "m",
        emits: "mic",
        label: "MIC",
        tx: 3,
        ty: 3,
        threshold: 1,
        accepts: ["dash"],
      });

    const walked = ctx({ heardAt: audibleWorld([{ loudness: 3, kind: "step" }]) });
    make().update(walked);
    expect(walked.bus.isHigh("mic")).toBe(false);

    const dashed = ctx({ heardAt: audibleWorld([{ loudness: 3, kind: "dash" }]) });
    make().update(dashed);
    expect(dashed.bus.isHigh("mic")).toBe(true);
  });

  it("is not deafened by a louder noise of the wrong kind", () => {
    // The bug this pins: asking for the loudest sound and then checking its
    // kind lets an unrelated footstep on the same tick mask the dash the sensor
    // was waiting for. The dash was audible; it just was not the loudest thing.
    const mic = new SoundSensor({
      kind: "sound",
      id: "m",
      emits: "mic",
      label: "MIC",
      tx: 3,
      ty: 3,
      threshold: 1,
      accepts: ["dash"],
    });
    const c = ctx({
      heardAt: audibleWorld([
        { loudness: 9, kind: "step" },
        { loudness: 2, kind: "dash" },
      ]),
    });
    mic.update(c);
    expect(c.bus.isHigh("mic")).toBe(true);
  });

  it("holds long enough to be useful after the noise has passed", () => {
    const mic = new SoundSensor({
      kind: "sound",
      id: "m",
      emits: "mic",
      label: "MIC",
      tx: 3,
      ty: 3,
      threshold: 1,
      holdSeconds: 4,
    });
    let loud = true;
    const c = ctx({
      heardAt: () => (loud ? { loudness: 3, kind: "dash", source: "echo" } : null),
    });
    mic.update(c);
    c.bus.beginTick();
    loud = false;
    run(mic, c, 3);
    expect(c.bus.strength("mic")).toBeGreaterThan(0);
    run(mic, c, 2);
    expect(c.bus.strength("mic")).toBe(0);
  });
});

describe("camera tap", () => {
  it("only pays out for a decoy, not for being seen yourself", () => {
    const make = () =>
      new CameraTap({
        kind: "cameraTap",
        id: "t",
        emits: "bait",
        label: "DECOY",
        cameraId: "cam",
        target: "echo",
      });

    const sawPlayer = ctx({ cameraSaw: () => "player" });
    make().update(sawPlayer);
    expect(sawPlayer.bus.isHigh("bait")).toBe(false);

    const sawEcho = ctx({ cameraSaw: () => "echo" });
    make().update(sawEcho);
    expect(sawEcho.bus.isHigh("bait")).toBe(true);
  });
});

describe("MIMIC scanner", () => {
  it("opens for MIMIC and for nothing the player can do", () => {
    const arch = new MimicScanner({
      kind: "mimicScanner",
      id: "a",
      emits: "auth",
      label: "ARCH",
      area: r(2, 2, 3, 3),
    });
    const crowded = ctx({
      bodies: [at(2, 2, "player"), at(3, 3, "echo", "e1")],
      mimic: { x: -999, y: -999, state: "patrol", alerted: false },
    });
    arch.update(crowded);
    expect(crowded.bus.isHigh("auth")).toBe(false);

    const withMimic = ctx({
      mimic: { x: 2.5 * TILE, y: 2.5 * TILE, state: "patrol", alerted: false },
    });
    arch.update(withMimic);
    expect(withMimic.bus.isHigh("auth")).toBe(true);
  });

  it("keeps the authorisation alive after MIMIC walks off", () => {
    const arch = new MimicScanner({
      kind: "mimicScanner",
      id: "a",
      emits: "auth",
      label: "ARCH",
      area: r(2, 2, 3, 3),
      holdSeconds: 3,
    });
    // Assigned rather than supplied as a getter: spreading a getter into the
    // context evaluates it once, which would leave MIMIC standing in the arch
    // forever and quietly make this test prove nothing.
    const c = ctx({ mimic: { x: 2.5 * TILE, y: 2.5 * TILE, state: "patrol", alerted: false } });
    arch.update(c);
    c.bus.beginTick();
    c.mimic = { x: -999, y: -999, state: "patrol", alerted: false };
    run(arch, c, 2);
    expect(c.bus.strength("auth")).toBeGreaterThan(0);
    run(arch, c, 2);
    expect(c.bus.strength("auth")).toBe(0);
  });
});

describe("spent-ability window", () => {
  it("opens exactly while the counter-measure is on cooldown", () => {
    const w = new AbilityWindow({
      kind: "abilityWindow",
      id: "w",
      emits: "spent",
      label: "BUFFER",
      abilityId: "door_control",
    });
    let spent = false;
    const c = ctx({ abilityOnCooldown: (id) => spent && id === "door_control" });

    w.update(c);
    expect(c.bus.isHigh("spent")).toBe(false);
    c.bus.beginTick();

    spent = true;
    w.update(c);
    expect(c.bus.isHigh("spent")).toBe(true);
  });
});

describe("latch", () => {
  it("remembers the instant every condition lined up", () => {
    const l = new Latch({
      kind: "latch",
      id: "l",
      emits: "done",
      label: "ARRAY",
      when: { all: ["a", "b"] },
    });
    const c = ctx();

    c.bus.raise("a");
    l.update(c);
    expect(c.bus.isHigh("done")).toBe(false);
    c.bus.beginTick();

    c.bus.raise("a");
    c.bus.raise("b");
    l.update(c);
    expect(c.bus.isHigh("done")).toBe(true);
    c.bus.beginTick();

    // The door must not slam the moment one ECHO steps off its pad.
    l.update(c);
    expect(c.bus.isHigh("done")).toBe(true);
  });

  it("is cleared by a RETRACE, so nothing is banked by accident", () => {
    const l = new Latch({ kind: "latch", id: "l", emits: "done", label: "X", when: "a" });
    const c = ctx();
    c.bus.raise("a");
    l.update(c);
    expect(l.isLatched).toBe(true);

    l.reset();
    c.bus.clear();
    l.update(c);
    expect(c.bus.isHigh("done")).toBe(false);
  });
});

describe("sequence", () => {
  const make = () =>
    new Sequence({
      kind: "sequence",
      id: "s",
      emits: "cascade",
      label: "CASCADE",
      steps: ["a", "b", "c"],
      windowSeconds: 2,
    });

  it("completes when the stages arrive in order", () => {
    const s = make();
    const c = ctx();
    for (const step of ["a", "b", "c"]) {
      c.bus.raise(step);
      s.update(c);
      c.bus.beginTick();
    }
    s.update(c);
    expect(c.bus.isHigh("cascade")).toBe(true);
  });

  it("resets rather than failing when a stage times out", () => {
    const s = make();
    const c = ctx();
    c.bus.raise("a");
    s.update(c);
    c.bus.beginTick();
    expect(s.progress).toBe(1);

    run(s, c, 3);
    expect(s.progress).toBe(0);
  });

  it("does not accept stages out of order", () => {
    const s = make();
    const c = ctx();
    c.bus.raise("c");
    s.update(c);
    expect(s.progress).toBe(0);
    expect(c.bus.isHigh("cascade")).toBe(false);
  });
});

describe("the signal bus", () => {
  it("clears every tick, so nothing sticks by accident", () => {
    const bus = new SignalBus();
    bus.raise("x");
    expect(bus.isHigh("x")).toBe(true);
    bus.beginTick();
    expect(bus.isHigh("x")).toBe(false);
  });

  it("reports the rising edge exactly once", () => {
    const bus = new SignalBus();
    bus.raise("x");
    expect(bus.justRose("x")).toBe(true);
    bus.beginTick();
    bus.raise("x");
    expect(bus.justRose("x")).toBe(false);
  });

  it("evaluates nested conditions", () => {
    const bus = new SignalBus();
    bus.raise("a");
    bus.raise("b");
    expect(bus.evaluate({ all: ["a", "b"] })).toBe(true);
    expect(bus.evaluate({ all: ["a", "c"] })).toBe(false);
    expect(bus.evaluate({ any: ["c", "a"] })).toBe(true);
    expect(bus.evaluate({ not: "c" })).toBe(true);
    expect(bus.evaluate({ atLeast: 2, of: ["a", "b", "c"] })).toBe(true);
    expect(bus.evaluate({ atLeast: 3, of: ["a", "b", "c"] })).toBe(false);
  });

  it("takes the strongest of several emitters on one id", () => {
    const bus = new SignalBus();
    bus.raise("x", 0.3);
    bus.raise("x", 0.9);
    bus.raise("x", 0.1);
    expect(bus.strength("x")).toBeCloseTo(0.9);
  });
});
