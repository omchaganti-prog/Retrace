/**
 * Sound is the other half of stealth: it must fall off with distance, be
 * surcharged by walls, and let a recorded sprint work as bait.
 */
import { describe, expect, it } from "vitest";
import { SOUND } from "../src/core/constants";
import { SoundBus, footstepLoudness, loudnessAt, propagate } from "../src/systems/sound";
import { tileCenter } from "../src/world/level";
import { footstepGain } from "../src/world/tiles";
import { Tile } from "../src/world/tiles";
import { testLevel } from "./helpers";

describe("sound propagation", () => {
  it("gets quieter with distance", () => {
    const level = testLevel();
    const src = tileCenter(1, 3);
    const near = tileCenter(3, 3);
    const far = tileCenter(7, 3);

    const ev = { x: src.x, y: src.y, loudness: 10, kind: "step" as const, source: "player" as const };
    const a = loudnessAt(level, ev, near.x, near.y);
    const b = loudnessAt(level, ev, far.x, far.y);

    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
  });

  it("charges extra to pass through a wall", () => {
    const level = testLevel();
    const src = tileCenter(3, 1);
    const field = propagate(level, src.x, src.y, 12);

    // (5,1) is directly behind the wall plug at x=4; (3,3) is the same number of
    // tiles away through open floor.
    const throughWall = field.get(level.idx(5, 1)) ?? 0;
    const throughOpen = field.get(level.idx(3, 3)) ?? 0;
    expect(throughOpen).toBeGreaterThan(throughWall);
  });

  it("is inaudible once the budget runs out", () => {
    const level = testLevel();
    const src = tileCenter(1, 3);
    const far = tileCenter(7, 3);
    const ev = { x: src.x, y: src.y, loudness: 2, kind: "step" as const, source: "player" as const };
    expect(loudnessAt(level, ev, far.x, far.y)).toBe(0);
  });

  it("makes sprinting materially louder than walking", () => {
    expect(footstepLoudness(true, 1)).toBeGreaterThan(footstepLoudness(false, 1) * 1.5);
  });

  it("carries further on grating and less in shadow", () => {
    expect(footstepGain(Tile.Grate)).toBeGreaterThan(1);
    expect(footstepGain(Tile.Shadow)).toBeLessThan(1);
  });
});

describe("sound bus", () => {
  it("reports the loudest audible event at a listener", () => {
    const level = testLevel();
    const bus = new SoundBus();
    const listener = tileCenter(4, 3);

    bus.emit(level, {
      ...tileCenter(3, 3),
      loudness: SOUND.footstepWalk,
      kind: "step",
      source: "player",
    });
    bus.emit(level, {
      ...tileCenter(5, 3),
      loudness: SOUND.footstepSprint,
      kind: "sprint",
      source: "echo",
      ownerId: "echo-1",
    });

    const heard = bus.loudestAt(level, listener.x, listener.y);
    expect(heard).not.toBeNull();
    // The ECHO's sprint wins — which is exactly what makes it usable as bait.
    expect(heard!.event.source).toBe("echo");
    expect(heard!.event.kind).toBe("sprint");
  });

  it("hears nothing once the tick is closed out", () => {
    const level = testLevel();
    const bus = new SoundBus();
    const at = tileCenter(3, 3);
    bus.emit(level, { ...at, loudness: 8, kind: "step", source: "player" });
    bus.endTick(1 / 60);
    expect(bus.loudestAt(level, at.x, at.y)).toBeNull();
  });
});
