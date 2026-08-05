/**
 * Acceptance criterion from the brief: "Record a path, RETRACE, and verify an
 * Echo follows the same path precisely... compare arrays of positions/actions."
 */
import { describe, expect, it } from "vitest";
import { ECHO, TICK_RATE } from "../src/core/constants";
import { Echo, EchoManager, Recorder, poseAt } from "../src/systems/echo";
import type { Dir } from "../src/core/math";

function recordWalk(steps: number): Recorder {
  const rec = new Recorder();
  for (let i = 0; i < steps; i++) {
    rec.sample(10 + i * 2, 40 - i, (i % 4) as Dir, i % 3 !== 0, i % 5 === 0);
  }
  return rec;
}

describe("echo recording", () => {
  it("replays every recorded position exactly", () => {
    const recorder = recordWalk(120);
    const rec = recorder.finish(1);
    expect(rec).not.toBeNull();

    const echo = new Echo(rec!);
    const replayed: [number, number][] = [];
    for (let i = 0; i < rec!.length; i++) {
      replayed.push([echo.x, echo.y]);
      echo.advance(1 / TICK_RATE);
    }

    const original = Array.from({ length: rec!.length }, (_, i) => {
      const p = poseAt(rec!, i);
      return [p.x, p.y] as [number, number];
    });
    expect(replayed).toEqual(original);
  });

  it("fires each recorded action once, on its original tick", () => {
    const recorder = new Recorder();
    for (let i = 0; i < 30; i++) {
      recorder.sample(i, i, 0, true, false);
      if (i === 7) recorder.action({ kind: "interact", propId: "SW1", x: i, y: i });
      if (i === 19) {
        recorder.action({ kind: "sound", sound: "sprint", loudness: 6.5, x: i, y: i });
      }
    }
    const echo = new Echo(recorder.finish(1)!);

    const interactTicks: number[] = [];
    const soundTicks: number[] = [];
    for (let t = 0; t < 30; t++) {
      echo.advance(1 / TICK_RATE);
      if (echo.firedInteractions.includes("SW1")) interactTicks.push(t);
      if (echo.firedSounds.length > 0) soundTicks.push(t);
    }

    // Each action is stamped with the frame that was being captured when it
    // happened, and replays when the echo reaches that same frame.
    expect(interactTicks).toEqual([7]);
    expect(soundTicks).toEqual([19]);
  });

  it("settles into residue and holds its final pose", () => {
    const echo = new Echo(recordWalk(10).finish(1)!);
    for (let i = 0; i < 40; i++) echo.advance(1 / TICK_RATE);

    expect(echo.phase).toBe("residue");
    // A plate held at the end of a run must stay held, or multi-plate gates
    // would be unsolvable.
    expect(echo.x).toBe(10 + 9 * 2);
    expect(echo.moving).toBe(false);
  });

  it("keeps a timeline running while dissipated rather than pausing it", () => {
    const echo = new Echo(recordWalk(600).finish(1)!);
    for (let i = 0; i < 60; i++) echo.advance(1 / TICK_RATE);
    const atDisrupt = echo.tick;

    echo.disrupt();
    expect(echo.isSolid).toBe(false);
    // Long enough to outlast ECHO.disruptSeconds and rejoin the timeline.
    const held = Math.ceil((ECHO.disruptSeconds + 0.5) * TICK_RATE);
    for (let i = 0; i < held; i++) echo.advance(1 / TICK_RATE);

    // The timeline kept running while it was dissolved; it does not get to
    // pause and catch up later.
    expect(echo.tick).toBe(atDisrupt + held);
    expect(echo.phase).toBe("replay");
    expect(echo.isSolid).toBe(true);
  });

  it("caps at three and evicts the oldest", () => {
    const mgr = new EchoManager();
    for (let run = 1; run <= 5; run++) mgr.add(recordWalk(20).finish(run)!);

    expect(mgr.count).toBe(ECHO.maxActive);
    expect(mgr.echoes.map((e) => e.rec.run)).toEqual([3, 4, 5]);
  });

  it("rewinds every timeline together so multi-echo puzzles stay aligned", () => {
    const mgr = new EchoManager();
    mgr.add(recordWalk(40).finish(1)!);
    for (let i = 0; i < 15; i++) mgr.advanceAll(1 / TICK_RATE);
    mgr.add(recordWalk(40).finish(2)!);

    mgr.rewindAll();
    expect(mgr.echoes.map((e) => e.tick)).toEqual([0, 0]);
  });

  it("refuses to bank a run with nothing in it", () => {
    expect(new Recorder().finish(1)).toBeNull();
  });
});
