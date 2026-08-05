/**
 * MIMIC's eye.
 *
 * The eye is the game's only readout for what MIMIC is thinking, so the property
 * that actually matters is not "does it animate" but "does it never lie". Every
 * test here is a claim about the mapping between the simulation and the picture:
 * if detection is rising the pupil must be closing, if it took a decoy the eye
 * must visibly break, and a state the AI is not in must never be shown.
 *
 * These run headless because the controller deliberately owns no canvas.
 */
import { describe, expect, it } from "vitest";
import { TICK_DT } from "../src/core/constants";
import { EYE_STATES, MimicEyeController } from "../src/render/mimic-eye";
import type { EyeSnapshot } from "../src/render/mimic-eye";

const base: EyeSnapshot = {
  state: "patrol",
  detection: 0,
  playerDetected: false,
  confusionT: 0,
  focusPulse: 0,
  hunt: false,
  power: 1,
  drain: 0,
  target: "none",
  predictionConfidence: 0,
  jamming: false,
  ability: null,
};

/** Runs the controller for a while so eased values reach their targets. */
function settle(eye: MimicEyeController, s: Partial<EyeSnapshot>, seconds = 1): void {
  const ticks = Math.ceil(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) eye.update(TICK_DT, { ...base, ...s });
}

describe("the eye reflects the simulation", () => {
  it("rests wide and dim, so that anything else reads as a change", () => {
    const eye = new MimicEyeController();
    settle(eye, {});
    expect(eye.view.state).toBe("idle");
    expect(eye.view.pupil).toBeGreaterThan(0.7);
    expect(eye.view.glow).toBeLessThan(0.45);
  });

  it("closes the pupil as detection climbs, continuously", () => {
    // The player has to be able to read how long they have before they are
    // seen. A pupil that only snaps at 100% tells them nothing while it matters.
    const eye = new MimicEyeController();
    settle(eye, { detection: 0.2 }, 0.5);
    const early = eye.view.pupil;
    settle(eye, { detection: 0.9 }, 0.5);
    const late = eye.view.pupil;

    expect(eye.view.state).toBe("focusing");
    expect(late).toBeLessThan(early);
  });

  it("shows being seen even while MIMIC is nominally searching", () => {
    // Regression. Detection used to be classified *below* the ambient AI
    // states, so while MIMIC was investigating or alert — which is most of the
    // time it can see anything at all — a climbing detection was masked. At
    // 0.98, one frame from capture, the eye still read as a relaxed search.
    // Being seen has to outrank whatever MIMIC is doing while it sees you.
    for (const state of ["investigate", "alert", "intercept"] as const) {
      const eye = new MimicEyeController();
      settle(eye, { state, detection: 0.9 }, 0.6);
      expect(eye.view.state, `${state} must not mask detection`).toBe("focusing");
      expect(eye.view.pupil).toBeLessThan(0.5);
    }
  });

  it("brightens as detection climbs", () => {
    const eye = new MimicEyeController();
    settle(eye, { detection: 0.15 }, 0.5);
    const dim = eye.view.glow;
    settle(eye, { detection: 0.95 }, 0.5);
    expect(eye.view.glow).toBeGreaterThan(dim);
  });

  it("locks hard on the frame the sighting is confirmed", () => {
    const eye = new MimicEyeController();
    settle(eye, { detection: 0.9 }, 0.4);
    eye.update(TICK_DT, { ...base, detection: 1, playerDetected: true });

    expect(eye.view.state).toBe("locked");
    // The lock is a one-shot the rest of the game can hear.
    expect(eye.consumeCue()).toBe("lock");
  });

  it("does not wander once it has locked on", () => {
    // A confirmed target gets an eye that stops drifting. That stillness is what
    // makes being seen feel different from being suspected.
    const eye = new MimicEyeController();
    settle(eye, { playerDetected: true, detection: 1 }, 1.5);
    expect(Math.abs(eye.view.drift)).toBeLessThan(1e-9);
  });

  it("keeps chasing and losing sight visually distinct", () => {
    const seen = new MimicEyeController();
    settle(seen, { state: "chase", playerDetected: true, detection: 1 });

    const lost = new MimicEyeController();
    settle(lost, { state: "chase", playerDetected: false });

    expect(seen.view.state).toBe("locked");
    expect(lost.view.state).toBe("lostSight");
    // Losing you opens the eye back up; it is looking around again.
    expect(lost.view.aperture).toBeGreaterThan(seen.view.aperture);
  });
});

describe("the eye reacts before the body", () => {
  it("holds the body for a beat when a stimulus arrives", () => {
    const eye = new MimicEyeController();
    settle(eye, {});
    expect(eye.reactionHold).toBe(0);

    eye.update(TICK_DT, { ...base, state: "alert" });
    // The pause is what makes MIMIC look like it is deciding rather than
    // executing. Without it the turn reads as a script.
    expect(eye.reactionHold).toBeGreaterThan(0);
    expect(eye.consumeCue()).toBe("snap");
  });

  it("lets the hold expire rather than sticking", () => {
    const eye = new MimicEyeController();
    eye.update(TICK_DT, { ...base, state: "alert" });
    settle(eye, { state: "alert" }, 1);
    expect(eye.reactionHold).toBe(0);
  });
});

describe("the eye shows when it has been fooled", () => {
  it("breaks visibly while confused, and only then", () => {
    const calm = new MimicEyeController();
    settle(calm, {});
    expect(calm.view.flicker).toBe(1);

    const fooled = new MimicEyeController();
    // Flicker means exactly one thing — something disrupted MIMIC's model —
    // so a calm eye must never do it, or the tell is worthless.
    let flickered = false;
    for (let i = 0; i < 40; i++) {
      fooled.update(TICK_DT, { ...base, confusionT: 1 });
      if (fooled.view.flicker < 1) flickered = true;
    }
    expect(fooled.view.state).toBe("confused");
    expect(flickered).toBe(true);
  });

  it("widens the pupil when it takes a decoy, rather than narrowing it", () => {
    const eye = new MimicEyeController();
    settle(eye, { detection: 0.8 }, 0.5);
    const focused = eye.view.pupil;
    settle(eye, { confusionT: 1 }, 0.4);
    expect(eye.view.pupil).toBeGreaterThan(focused);
  });

  it("looks uncertain when tracking an ECHO it has not seen through", () => {
    const eye = new MimicEyeController();
    settle(eye, { state: "alert", target: "echo" }, 0.6);
    expect(eye.view.state).toBe("uncertain");
  });
});

describe("prediction is shown, never printed", () => {
  it("runs a prediction tell when confidence appears", () => {
    const eye = new MimicEyeController();
    settle(eye, {}, 0.3);
    eye.update(TICK_DT, { ...base, predictionConfidence: 0.7 });
    expect(eye.view.state).toBe("predicting");
    expect(eye.consumeCue()).toBe("predict");
  });

  it("tells the player when a confident prediction came to nothing", () => {
    // This is the payoff for breaking MIMIC's model of you, so it has to be
    // visible without any UI saying so.
    const eye = new MimicEyeController();
    settle(eye, { predictionConfidence: 0.8 }, 1.2);
    eye.update(TICK_DT, { ...base, predictionConfidence: 0 });

    expect(eye.view.state).toBe("predictionFailed");
    expect(eye.consumeCue()).toBe("fail");
  });

  it("does not call it a failure when the prediction paid off", () => {
    // Prediction ending *because it found you* is a success, and must not play
    // the same animation as being wrong.
    const eye = new MimicEyeController();
    settle(eye, { predictionConfidence: 0.8 }, 1.2);
    eye.consumeCue();
    eye.update(TICK_DT, { ...base, predictionConfidence: 0, playerDetected: true });

    expect(eye.view.state).toBe("locked");
    expect(eye.consumeCue()).not.toBe("fail");
  });

  it("is calmer and more certain the more confident it is", () => {
    const unsure = new MimicEyeController();
    settle(unsure, { state: "alert", target: "echo", predictionConfidence: 0.05 }, 0.8);
    const sure = new MimicEyeController();
    settle(sure, { state: "alert", target: "echo", predictionConfidence: 0.95 }, 0.8);

    expect(sure.view.aperture).toBeLessThan(unsure.view.aperture);
  });
});

describe("the eye carries system state", () => {
  it("dims when MIMIC cannot afford to do anything", () => {
    const full = new MimicEyeController();
    settle(full, { detection: 0.5, power: 1 });
    const spent = new MimicEyeController();
    settle(spent, { detection: 0.5, power: 0.05 });
    expect(spent.view.glow).toBeLessThan(full.view.glow);
  });

  it("burns brighter in Hunt Mode without becoming a different eye", () => {
    const calm = new MimicEyeController();
    settle(calm, { state: "chase", playerDetected: true });
    const hunting = new MimicEyeController();
    settle(hunting, { state: "chase", playerDetected: true, hunt: true });

    expect(hunting.view.glow).toBeGreaterThanOrEqual(calm.view.glow);
    // Same state, same design — only the intensity changes.
    expect(hunting.view.state).toBe(calm.view.state);
  });

  it("goes cyan only while it is jamming RETRACE", () => {
    // Red is MIMIC and cyan is the player's timeline, so cyan in MIMIC's eye
    // means it is reaching into something of yours.
    const eye = new MimicEyeController();
    settle(eye, {});
    expect(eye.view.tint).toBe("red");
    settle(eye, { jamming: true }, 0.2);
    expect(eye.view.tint).toBe("cyan");
  });

  it("gives an ability its own tell", () => {
    const eye = new MimicEyeController();
    eye.update(TICK_DT, { ...base, ability: "scan" });
    expect(eye.view.ring).not.toBeNull();
  });
});

describe("the debug harness", () => {
  it("can pin every state, and hand control back", () => {
    const eye = new MimicEyeController();
    for (const state of EYE_STATES) {
      eye.force(state);
      eye.update(TICK_DT, base);
      expect(eye.view.state).toBe(state);
    }
    eye.force(null);
    settle(eye, {});
    expect(eye.view.state).toBe("idle");
  });

  it("stays inside its own bounds in every state", () => {
    // The renderer trusts these ranges; a value outside them draws a broken eye.
    const eye = new MimicEyeController();
    for (const state of EYE_STATES) {
      eye.force(state);
      for (let i = 0; i < 60; i++) {
        eye.update(TICK_DT, { ...base, detection: 0.5, power: 0.5, predictionConfidence: 0.5 });
        const v = eye.view;
        expect(v.pupil).toBeGreaterThanOrEqual(0);
        expect(v.pupil).toBeLessThanOrEqual(1);
        expect(v.aperture).toBeGreaterThanOrEqual(0);
        expect(v.aperture).toBeLessThanOrEqual(1);
        expect(v.glow).toBeGreaterThanOrEqual(0);
        expect(v.glow).toBeLessThanOrEqual(1);
        expect(v.flicker).toBeGreaterThan(0);
        expect(v.flicker).toBeLessThanOrEqual(1);
      }
    }
  });

  it("resets cleanly between runs", () => {
    const eye = new MimicEyeController();
    settle(eye, { playerDetected: true, detection: 1, jamming: true });
    eye.reset();
    expect(eye.view.state).toBe("idle");
    expect(eye.view.tint).toBe("red");
    expect(eye.reactionHold).toBe(0);
  });
});
