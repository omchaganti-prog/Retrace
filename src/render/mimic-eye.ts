/**
 * MIMIC's eye.
 *
 * MIMIC is a dark disc with one red eye, and that eye is the only part of it
 * that can express anything. So it is not decoration: it is the readout for the
 * AI behind it. Every movement here has a cause in the simulation, because the
 * whole point is that a player who watches it for long enough stops needing the
 * HUD — "it's searching", "it's checking my usual route", "it took the decoy".
 *
 * The one rule this file exists to enforce:
 *
 *     THE EYE REACTS FIRST, THE BODY FOLLOWS.
 *
 * A noise behind MIMIC snaps the eye instantly, holds for a beat, and only then
 * does the body come round. That fractional pause is the entire difference
 * between a machine that looks like it is executing a state transition and one
 * that looks like it is deciding.
 *
 * This file is deliberately free of canvas calls. It consumes a snapshot of the
 * simulation and produces a small struct of numbers; the renderer draws them.
 * That keeps the animation testable without a browser, and it means the eye can
 * never accidentally become a source of truth — it only ever reflects one.
 */
import type { MimicState } from "../entities/mimic";
import type { MimicFxKind } from "../ai/abilities";

/**
 * What the eye is doing, as distinct from what MIMIC is doing.
 *
 * These are finer-grained than the AI's own states because a single AI state
 * looks like several different things: `chase` with the player in view and
 * `chase` two seconds after losing them should not read the same.
 */
export type EyeState =
  | "idle"
  | "heard"
  | "suspicious"
  | "focusing"
  | "locked"
  | "lostSight"
  | "searching"
  | "uncertain"
  | "confused"
  | "predicting"
  | "predictionFailed"
  | "ability";

/** What the eye is currently interested in. Drives uncertainty behaviour. */
export type EyeTarget = "none" | "player" | "echo" | "sound";

/** Everything the eye is allowed to know. Read-only; the eye never writes back. */
export interface EyeSnapshot {
  state: MimicState;
  /** 0..1 detection buildup toward a confirmed sighting. */
  detection: number;
  /** True once MIMIC has confirmed it is looking at the living player. */
  playerDetected: boolean;
  /** Seconds of hesitation left; MIMIC stands still while this runs. */
  confusionT: number;
  /** Short spike on the frame a sighting is confirmed. */
  focusPulse: number;
  /** Hunt Mode: same entity, maximum alert. */
  hunt: boolean;
  /** 0..1 system power. A spent MIMIC has a dim, guttering eye. */
  power: number;
  /** 0..1 recovery drag after a big spend. */
  drain: number;
  /** What it is tracking right now. */
  target: EyeTarget;
  /** 0..1 confidence in its route prediction, if it has one. */
  predictionConfidence: number;
  /** True while MIMIC is actively jamming the RETRACE link. */
  jamming: boolean;
  /** An ability that fired this frame, if any. */
  ability: MimicFxKind | null;
}

/** Numbers the renderer draws. Nothing here is a decision, only a value. */
export interface EyeView {
  /** 0..1 pupil size. 1 is relaxed and wide, 0 is a focused pinpoint. */
  pupil: number;
  /** 0..1 lid openness. Narrow reads as concentration, wide as surprise. */
  aperture: number;
  /** 0..1 core brightness before flicker is applied. */
  glow: number;
  /** 0..1 multiplier on glow. Below 1 only when something disrupted it. */
  flicker: number;
  /** Expanding scan ring as 0..1 progress, or null when none is running. */
  ring: number | null;
  /**
   * Temporal interference reads cyan because cyan is the game's word for the
   * player's own timeline — MIMIC's red bleeding into it is the tell that it is
   * reaching into something of yours.
   */
  tint: "red" | "cyan";
  /** Small additive wander, in radians, so a resting eye is not dead. */
  drift: number;
  state: EyeState;
}

/**
 * A one-shot the eye wants the rest of the game to notice — a sound to play, in
 * practice. Pulled rather than pushed so this file stays free of dependencies.
 */
export type EyeCue = "snap" | "lock" | "predict" | "fail";

/* ------------------------------------------------------------------ tuning */

/** Seconds the eye holds on a new stimulus before the body is allowed to turn. */
export const EYE_REACTION_HOLD = 0.18;
/** How long a lock flash reads for. */
const LOCK_FLASH = 0.45;
/** How long a prediction sweep runs. */
const PREDICT_TIME = 0.7;
/** How long the "prediction failed" tell runs. */
const FAIL_TIME = 0.9;
/** Scan-ring lifetime. */
const RING_TIME = 0.55;

/** Per-state resting targets: [pupil, aperture, glow]. */
const REST: Record<EyeState, [number, number, number]> = {
  // Wide and dim. Stillness is most of MIMIC's personality, so the calm state
  // has to be genuinely calm or nothing else reads as a change.
  idle: [0.85, 1.0, 0.3],
  heard: [0.6, 0.95, 0.5],
  suspicious: [0.55, 0.8, 0.5],
  focusing: [0.4, 0.7, 0.68],
  locked: [0.22, 0.62, 1.0],
  lostSight: [0.7, 1.0, 0.62],
  searching: [0.62, 0.85, 0.5],
  uncertain: [0.7, 0.9, 0.55],
  confused: [0.95, 1.0, 0.42],
  predicting: [0.2, 0.55, 0.8],
  predictionFailed: [1.0, 1.0, 0.5],
  ability: [0.3, 0.65, 0.9],
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Frame-rate independent approach. */
const toward = (a: number, b: number, rate: number, dt: number): number =>
  a + (b - a) * clamp01(rate * dt);

export class MimicEyeController {
  readonly view: EyeView = {
    pupil: 0.85,
    aperture: 1,
    glow: 0.3,
    flicker: 1,
    ring: null,
    tint: "red",
    drift: 0,
    state: "idle",
  };

  /**
   * Seconds the body must wait before it is allowed to act on what the eye has
   * already noticed. The Mimic reads this; it is the whole "thinks before it
   * acts" effect, and the only value in here the simulation consults.
   */
  reactionHold = 0;

  private state: EyeState = "idle";
  private stateT = 0;
  private ringT = 0;
  private flashT = 0;
  private predictT = 0;
  private failT = 0;
  private cue: EyeCue | null = null;
  private lastState: MimicState = "patrol";
  private wasDetected = false;
  private hadPrediction = false;
  private driftPhase = 0;
  /** Debug override; null in normal play. */
  private forced: EyeState | null = null;

  reset(): void {
    this.state = "idle";
    this.stateT = 0;
    this.ringT = 0;
    this.flashT = 0;
    this.predictT = 0;
    this.failT = 0;
    this.cue = null;
    this.reactionHold = 0;
    this.wasDetected = false;
    this.hadPrediction = false;
    this.forced = null;
    this.view.pupil = 0.85;
    this.view.aperture = 1;
    this.view.glow = 0.3;
    this.view.flicker = 1;
    this.view.ring = null;
    this.view.tint = "red";
    this.view.state = "idle";
  }

  /**
   * Debug only: pin the eye to one state so animations can be tuned.
   *
   * Every timer is cleared first. Without that, stepping through the states in
   * order leaks the previous one's tell into the next — the failure flicker was
   * still running underneath the ability tell — and what you are looking at is
   * no longer the state you asked for.
   */
  force(state: EyeState | null): void {
    this.forced = state;
    this.ringT = 0;
    this.flashT = 0;
    this.predictT = 0;
    this.failT = 0;
    if (state) {
      this.state = state;
      this.stateT = 0;
      if (state === "predicting") this.predictT = PREDICT_TIME;
      if (state === "predictionFailed") this.failT = FAIL_TIME;
      if (state === "locked") this.flashT = LOCK_FLASH;
      if (state === "ability") this.ringT = RING_TIME;
    }
  }

  get forcedState(): EyeState | null {
    return this.forced;
  }

  /** Take the pending one-shot, if any. */
  consumeCue(): EyeCue | null {
    const c = this.cue;
    this.cue = null;
    return c;
  }

  update(dt: number, s: EyeSnapshot): void {
    /* ----------------------------------------------------------- events */

    // A stimulus MIMIC did not have last frame. The eye takes it immediately;
    // the body is held off for a beat by `reactionHold`.
    const newlyAlerted =
      (s.state === "alert" || s.state === "intercept") &&
      this.lastState !== "alert" &&
      this.lastState !== "intercept";
    if (newlyAlerted) {
      this.reactionHold = EYE_REACTION_HOLD;
      this.cue = "snap";
      this.flashT = Math.max(this.flashT, 0.12);
    }

    // Confirmation. This is the single most important frame in the whole
    // system: it is the moment the run changes, and it gets a hard flash.
    if (s.playerDetected && !this.wasDetected) {
      this.flashT = LOCK_FLASH;
      this.ringT = RING_TIME;
      this.cue = "lock";
    }

    // A prediction that was running and is now gone without a confirmed
    // sighting is a prediction that did not pay off. That is worth a tell —
    // it is the player's proof that they broke MIMIC's model of them.
    const hasPrediction = s.predictionConfidence > 0.05;
    if (this.hadPrediction && !hasPrediction && !s.playerDetected) {
      this.failT = FAIL_TIME;
      this.cue = "fail";
    }
    if (hasPrediction && !this.hadPrediction) {
      this.predictT = PREDICT_TIME;
      this.cue = "predict";
    }

    if (s.ability) {
      this.ringT = RING_TIME;
      // Route prediction gets the thinking animation rather than a plain ring.
      if (s.ability === "predict") this.predictT = PREDICT_TIME;
    }

    this.reactionHold = Math.max(0, this.reactionHold - dt);
    this.ringT = Math.max(0, this.ringT - dt);
    this.flashT = Math.max(0, this.flashT - dt);
    this.predictT = Math.max(0, this.predictT - dt);
    this.failT = Math.max(0, this.failT - dt);

    /* ------------------------------------------------------- what it is */

    const next = this.forced ?? this.classify(s);
    if (next !== this.state) {
      this.state = next;
      this.stateT = 0;
    } else {
      this.stateT += dt;
    }

    /* ------------------------------------------------------- the values */

    const [restPupil, restAperture, restGlow] = REST[this.state];
    let pupil = restPupil;
    let aperture = restAperture;
    let glow = restGlow;

    // Detection is a continuous thing and must animate continuously, or the
    // player cannot read how much time they have left before they are seen.
    if (this.state === "focusing") {
      // Pinned for tuning with no real detection behind it, the buildup would
      // sit at zero and look exactly like idle — which is the one thing the
      // panel exists to let you tell apart. Show it mid-climb instead.
      const d = clamp01(this.forced === "focusing" ? Math.max(s.detection, 0.6) : s.detection);
      pupil = 0.85 - 0.55 * d;
      aperture = 1 - 0.32 * d;
      glow = 0.32 + 0.5 * d;
    }

    // Confidence, shown rather than printed: a MIMIC that is sure of you barely
    // moves its eye; an unsure one hunts around with a wide aperture.
    if (this.state === "predicting" || this.state === "uncertain") {
      const c = clamp01(s.predictionConfidence);
      aperture = restAperture - 0.15 * c + 0.12 * (1 - c);
      pupil = restPupil * (1 - 0.25 * c);
    }

    // Hunt Mode is the same eye at maximum alert, never a different design.
    if (s.hunt) {
      glow = Math.min(1, glow * 1.25 + 0.12);
      pupil *= 0.88;
    }

    // Power is legible in the eye rather than on a bar: a spent MIMIC is dim
    // and unsteady, and an observant player can tell it cannot afford anything.
    const guttering = s.power < 0.25 ? 0.72 + 0.28 * Math.sin(this.driftPhase * 9) : 1;
    glow *= (0.55 + 0.45 * s.power) * guttering * (1 - s.drain * 0.35);

    // The lock flash rides on top of everything else.
    if (this.flashT > 0) {
      const k = this.flashT / LOCK_FLASH;
      glow = Math.min(1, glow + 0.6 * k);
      aperture = Math.min(1, aperture + 0.25 * k);
    }
    glow = Math.min(1, glow + s.focusPulse * 0.4);

    /* --------------------------------------------------------- movement */

    // Snap on stimulus, ease otherwise. The asymmetry is the character: MIMIC
    // notices instantly and relaxes slowly.
    const snapping =
      this.flashT > 0 || this.predictT > 0 || this.state === "confused" || newlyAlerted;
    const rate = snapping ? 26 : 7;
    this.view.pupil = toward(this.view.pupil, clamp01(pupil), rate, dt);
    this.view.aperture = toward(this.view.aperture, clamp01(aperture), rate, dt);
    this.view.glow = toward(this.view.glow, clamp01(glow), snapping ? 30 : 9, dt);

    /* ---------------------------------------------------------- flicker */

    // Flicker is reserved. It means exactly one thing — something disrupted
    // MIMIC's model of the world — so it must never fire for decoration.
    let flicker = 1;
    if (this.state === "confused" || this.failT > 0) {
      const t = this.driftPhase * 34;
      flicker = 0.55 + 0.45 * (Math.sin(t) > 0.2 ? 1 : 0.35);
    } else if (s.jamming) {
      flicker = 0.85 + 0.15 * Math.sin(this.driftPhase * 26);
    }
    this.view.flicker = flicker;

    /* ------------------------------------------------------------ drift */

    // A resting eye still lives. Deliberately tiny, and switched off entirely
    // once MIMIC has locked on: a confirmed target gets an eye that does not
    // wander, which is what makes being seen feel different.
    this.driftPhase += dt;
    const wander = this.state === "locked" || this.state === "predicting" ? 0 : 1;
    this.view.drift =
      wander * 0.13 * Math.sin(this.driftPhase * 0.9) * Math.sin(this.driftPhase * 0.37 + 1.1);

    this.view.ring = this.ringT > 0 ? 1 - this.ringT / RING_TIME : null;
    this.view.tint = s.jamming ? "cyan" : "red";
    this.view.state = this.state;

    this.lastState = s.state;
    this.wasDetected = s.playerDetected;
    this.hadPrediction = hasPrediction;
  }

  /**
   * Which eye state the simulation adds up to.
   *
   * Ordered by how much the player needs to know it: a confirmed sighting
   * outranks everything, and the momentary tells (confusion, prediction) outrank
   * the steady ones so they are never swallowed by the state underneath.
   */
  private classify(s: EyeSnapshot): EyeState {
    if (this.failT > 0) return "predictionFailed";
    if (s.confusionT > 0) return "confused";
    if (this.predictT > 0) return "predicting";
    if (s.ability && this.ringT > 0) return "ability";
    if (s.playerDetected) return "locked";

    if (s.state === "chase") {
      // Chasing with no confirmation left is the moment it lost you, and it
      // must not look the same as chasing with you in view.
      return "lostSight";
    }
    if (s.state === "investigate") return "searching";
    if (s.state === "alert" || s.state === "intercept") {
      return s.target === "echo" ? "uncertain" : "heard";
    }
    if (s.detection > 0.05) return "focusing";
    return "idle";
  }
}

/** Every state, in the order a debug panel should offer them. */
export const EYE_STATES: readonly EyeState[] = [
  "idle",
  "heard",
  "suspicious",
  "focusing",
  "locked",
  "lostSight",
  "searching",
  "uncertain",
  "confused",
  "predicting",
  "predictionFailed",
  "ability",
];
