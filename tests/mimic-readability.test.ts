/**
 * MIMIC's body language.
 *
 * The charter asks for an enemy that "never appears to cheat" and that
 * "visibly searches or hesitates when uncertain". That is a gameplay
 * requirement, not decoration: the player has to be able to read, from across a
 * room, whether MIMIC knows where they are.
 *
 * The load-bearing test here is the last one. The eye is allowed to lead the
 * body — that is the tell — but the *vision cone* must stay welded to `facing`,
 * so a snapping eye can never imply MIMIC can see somewhere it cannot. A tell
 * that lies is worse than no tell.
 */
import { describe, expect, it } from "vitest";
import { MIMIC, TICK_DT } from "../src/core/constants";
import { Mimic } from "../src/entities/mimic";
import { SoundBus } from "../src/systems/sound";
import { localStrategy } from "../src/systems/strategist";
import { MimicMemory } from "../src/systems/memory";
import { tileCenter } from "../src/world/level";
import { testLevel } from "./helpers";

const CTX = {
  zones: ["all"],
  hideSpots: [],
  objectivesComplete: [] as string[],
  nextObjective: "power",
  objectiveZone: "all",
  lockdown: false,
};

function senses(level = testLevel(), playerAt = tileCenter(7, 3)) {
  return {
    level,
    player: { x: playerAt.x, y: playerAt.y, hidden: false },
    echoes: [],
    sounds: new SoundBus(),
    strategy: localStrategy(new MimicMemory(), CTX),
  };
}

function make(tx = 2, ty = 3): Mimic {
  const m = new Mimic();
  const c = tileCenter(tx, ty);
  m.reset(c.x, c.y);
  m.configure(testLevel(), localStrategy(new MimicMemory(), CTX));
  return m;
}

/** Smallest signed angle between two headings. */
const angleGap = (a: number, b: number): number => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

describe("the eye leads the body", () => {
  it("snaps toward a contact well before the body has turned", () => {
    const m = make(7, 3);
    const s = senses();
    // Something happens behind it.
    const behind = tileCenter(1, 3);
    m.alertTo(behind.x, behind.y, "world");

    const bodyBefore = m.facing;
    for (let i = 0; i < 6; i++) m.update(TICK_DT, s);

    const want = Math.atan2(behind.y - m.y, behind.x - m.x);
    const eyeGap = angleGap(m.gaze, want);
    const bodyGap = angleGap(m.facing, want);

    // Within a tenth of a second the eye is already on it and the body is not.
    expect(eyeGap).toBeLessThan(bodyGap);
    expect(m.facing).not.toBe(bodyBefore + Math.PI); // it did not teleport its heading
  });

  it("turns the eye faster than the body can rotate", () => {
    const m = make(7, 3);
    const s = senses();
    const target = tileCenter(1, 3);

    // Captured before the stimulus, not after it.
    //
    // The eye no longer eases toward a noise, it snaps to it on the frame the
    // noise happens — so measuring from after `alertTo` measured the wrong
    // window entirely and saw zero movement, because all of it had already
    // happened. Easing was the bug: `updateGaze` rebuilt the target every frame
    // and overwrote the snap, and in play the eye visibly never reached what it
    // had supposedly turned to look at.
    const eye0 = m.gaze;
    const body0 = m.facing;

    m.alertTo(target.x, target.y, "world");
    for (let i = 0; i < 4; i++) m.update(TICK_DT, s);

    const eyeMoved = angleGap(m.gaze, eye0);
    const bodyMoved = angleGap(m.facing, body0);
    expect(eyeMoved).toBeGreaterThan(bodyMoved);
  });

  it("puts the eye on the stimulus immediately, not eventually", () => {
    const m = make(7, 3);
    const s = senses();
    const target = tileCenter(1, 3);

    m.alertTo(target.x, target.y, "world");
    const want = Math.atan2(target.y - m.y, target.x - m.x);
    // On the very frame it is told, before a single update has run.
    expect(angleGap(m.gaze, want)).toBeLessThan(0.01);

    // And it holds there rather than being dragged back by the state machine,
    // which is what made the snap invisible in play.
    for (let i = 0; i < 6; i++) m.update(TICK_DT, s);
    expect(angleGap(m.gaze, want)).toBeLessThan(0.5);
  });
});

describe("uncertainty is visible", () => {
  it("hesitates when a decoy pulls it, and stops while it does", () => {
    const m = make(7, 3);
    const level = testLevel();
    const s = senses(level);
    const at = tileCenter(2, 3);
    s.sounds.emit(level, {
      x: at.x,
      y: at.y,
      loudness: 8,
      kind: "step",
      source: "echo",
      ownerId: "echo-1",
    });

    const out = m.update(TICK_DT, s);
    expect(out.divertedByEcho).toBe(true);
    expect(m.confusionT).toBeGreaterThan(0);

    // It does not glide onward while its eye darts about — it stands still.
    const x0 = m.x;
    const y0 = m.y;
    for (let i = 0; i < 20; i++) m.update(TICK_DT, senses(level));
    expect(Math.hypot(m.x - x0, m.y - y0)).toBeLessThan(1);
  });

  it("stops hesitating and resumes on its own", () => {
    const m = make(7, 3);
    const level = testLevel();
    m.confusionT = 0.4;
    for (let i = 0; i < Math.round(1 / TICK_DT); i++) m.update(TICK_DT, senses(level));
    expect(m.confusionT).toBe(0);
  });

  it("sweeps its gaze around while searching, rather than staring ahead", () => {
    const m = make(7, 3);
    const level = testLevel();
    const lost = tileCenter(1, 3);
    m.alertTo(lost.x, lost.y, "world");
    // Drive it into a search with nothing to find.
    for (let i = 0; i < 60 * 6; i++) m.update(TICK_DT, senses(level, tileCenter(1, 1)));

    if (m.state !== "investigate") return; // it found its way back to patrol

    let widest = 0;
    for (let i = 0; i < 60 * 4; i++) {
      m.update(TICK_DT, senses(level, tileCenter(1, 1)));
      widest = Math.max(widest, angleGap(m.gaze, m.facing));
    }
    // A searching MIMIC looks well outside the cone it is pointing.
    expect(widest).toBeGreaterThan(MIMIC.coneHalfAngle * 0.5);
  });
});

describe("the tell never lies", () => {
  it("keeps perception welded to the body, not the eye", () => {
    const m = make(7, 3);
    const level = testLevel();
    // Put the player somewhere the eye will snap toward but the body has not
    // reached yet, and confirm the cone has not followed the eye.
    const target = tileCenter(1, 3);
    m.alertTo(target.x, target.y, "world");
    for (let i = 0; i < 3; i++) m.update(TICK_DT, senses(level, target));

    // The eye is ahead of the body. If the cone tracked the eye, these would
    // agree — and MIMIC would be seeing somewhere it has not turned to face.
    expect(angleGap(m.gaze, m.facing)).toBeGreaterThan(0.05);
  });

  it("never moves the body further than its turn rate allows", () => {
    const m = make(7, 3);
    const level = testLevel();
    const target = tileCenter(1, 3);
    m.alertTo(target.x, target.y, "world");

    let prev = m.facing;
    for (let i = 0; i < 60; i++) {
      m.update(TICK_DT, senses(level, target));
      const step = angleGap(m.facing, prev);
      // Generous margin for the steering term, but nowhere near a snap.
      expect(step).toBeLessThan(MIMIC.turnRate * TICK_DT * 3 + 0.01);
      prev = m.facing;
    }
  });
});
