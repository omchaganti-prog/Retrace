/**
 * Sneaking.
 *
 * The third movement mode, and the only one whose entire value is measured in
 * the sound system: sprint buys distance and spends stamina *and* silence, sneak
 * buys silence and spends the clock. These tests check the trade is real — that
 * a creeping step genuinely dies before it reaches somewhere a walking step
 * would have been heard — and that a past self creeps exactly as quietly as you
 * did, which is what makes a recorded approach usable.
 */
import { describe, expect, it } from "vitest";
import { SOUND, TICK_DT, TILE } from "../src/core/constants";
import type { InputSnapshot } from "../src/core/input";
import { Player } from "../src/entities/player";
import { poseAt, Recorder } from "../src/systems/echo";
import { footstepLoudness, loudnessAt } from "../src/systems/sound";
import { tileCenter } from "../src/world/level";
import { testLevel } from "./helpers";

const IDLE: InputSnapshot = {
  up: false,
  down: false,
  left: false,
  right: false,
  sprint: false,
  sneak: false,
  dash: false,
};
const WALK = { ...IDLE, right: true };
const SNEAK = { ...IDLE, right: true, sneak: true };
const RUN = { ...IDLE, right: true, sprint: true };
const START = tileCenter(2, 3);

function fresh(): Player {
  const p = new Player();
  p.reset(START.x, START.y);
  return p;
}

function hold(p: Player, input: InputSnapshot, seconds: number): void {
  const level = testLevel();
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    p.update(TICK_DT, level, input);
    p.x = START.x;
    p.y = START.y;
  }
}

describe("the movement modes", () => {
  it("creeps slower than it walks, and walks slower than it runs", () => {
    const sneak = fresh();
    hold(sneak, SNEAK, 1);
    const walk = fresh();
    hold(walk, WALK, 1);
    const run = fresh();
    hold(run, RUN, 1);

    const speed = (p: Player) => Math.hypot(p.vx, p.vy);
    expect(speed(sneak)).toBeLessThan(speed(walk));
    expect(speed(walk)).toBeLessThan(speed(run));
    expect(sneak.sneaking).toBe(true);
  });

  it("costs no stamina — the price is time, not breath", () => {
    const p = fresh();
    hold(p, SNEAK, 4);
    expect(p.stamina).toBe(100);
    expect(p.exhausted).toBe(false);
  });

  it("yields to sprint when both are held, so panic never creeps", () => {
    const p = fresh();
    hold(p, { ...IDLE, right: true, sprint: true, sneak: true }, 0.5);
    expect(p.sprinting).toBe(true);
    expect(p.sneaking).toBe(false);
  });

  it("places its feet further apart in time", () => {
    const level = testLevel();
    const count = (input: InputSnapshot) => {
      const p = fresh();
      let steps = 0;
      for (let i = 0; i < Math.round(6 / TICK_DT); i++) {
        if (p.update(TICK_DT, level, input).stepped) steps++;
        p.x = START.x;
        p.y = START.y;
      }
      return steps;
    };
    expect(count(SNEAK)).toBeLessThan(count(WALK));
  });
});

describe("silence is the point", () => {
  it("makes a far quieter footstep than a walk or a sprint", () => {
    const walk = footstepLoudness(false, 1, false);
    const sneak = footstepLoudness(false, 1, true);
    const sprint = footstepLoudness(true, 1, false);
    expect(sneak).toBeLessThan(walk);
    expect(walk).toBeLessThan(sprint);
    // And it barely clears the floor at all, so it dies almost immediately.
    expect(sneak).toBeLessThan(SOUND.footstepWalk * 0.5);
  });

  it("dies before it reaches a listener a walk would have reached", () => {
    const level = testLevel();
    const from = tileCenter(1, 3);
    // Two tiles down the open corridor. A walk carries about 2.85 tiles of
    // budget, so this is comfortably inside its reach and far outside a creep's.
    const listenerX = tileCenter(3, 3).x;
    const listenerY = tileCenter(3, 3).y;

    const heardWalking = loudnessAt(
      level,
      { x: from.x, y: from.y, loudness: footstepLoudness(false, 1), kind: "step", source: "player" },
      listenerX,
      listenerY,
    );
    const heardSneaking = loudnessAt(
      level,
      {
        x: from.x,
        y: from.y,
        loudness: footstepLoudness(false, 1, true),
        kind: "sneak",
        source: "player",
      },
      listenerX,
      listenerY,
    );

    expect(heardWalking).toBeGreaterThan(0);
    expect(heardSneaking).toBe(0);
  });

  it("cannot be heard through a wall at all", () => {
    const level = testLevel();
    // Either side of the plug at x=4 on row 1.
    const from = tileCenter(3, 1);
    const behind = tileCenter(5, 1);
    const heard = loudnessAt(
      level,
      {
        x: from.x,
        y: from.y,
        loudness: footstepLoudness(false, 1, true),
        kind: "sneak",
        source: "player",
      },
      behind.x,
      behind.y,
    );
    expect(heard).toBe(0);
  });
});

describe("a past self creeps too", () => {
  it("records and replays the crouch, so a recorded approach stays quiet", () => {
    const rec = new Recorder();
    rec.sample(0, 0, 0, true, false, true);
    rec.sample(TILE, 0, 0, true, false, false);
    const out = rec.finish(1)!;

    expect(poseAt(out, 0).sneaking).toBe(true);
    expect(poseAt(out, 1).sneaking).toBe(false);
    // The flag must not disturb the facing bits it sits above.
    expect(poseAt(out, 0).dir).toBe(0);
    expect(poseAt(out, 0).moving).toBe(true);
  });

  it("keeps every pose flag independent", () => {
    const rec = new Recorder();
    // Every combination that can legitimately occur, plus the diagonal facings
    // that share the byte.
    rec.sample(0, 0, 7, true, true, false);
    rec.sample(0, 0, 5, true, false, true);
    rec.sample(0, 0, 3, false, false, false);
    const out = rec.finish(1)!;

    expect(poseAt(out, 0)).toMatchObject({ dir: 7, moving: true, sprinting: true, sneaking: false });
    expect(poseAt(out, 1)).toMatchObject({ dir: 5, moving: true, sprinting: false, sneaking: true });
    expect(poseAt(out, 2)).toMatchObject({ dir: 3, moving: false, sprinting: false, sneaking: false });
  });
});
