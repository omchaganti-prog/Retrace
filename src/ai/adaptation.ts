/**
 * What MIMIC has learned about *this* player.
 *
 * The premise of RETRACE is that you are teaching the thing hunting you how to
 * beat you. These counters are that lesson made concrete: they rise from what
 * you actually do, and they decide which counter-measures MIMIC develops and in
 * what order. Two players who solve the same wing differently should end up
 * facing measurably different opponents.
 *
 * Values are 0..100 and are deliberately slow. Adaptation is the one thing that
 * survives a Temporal Collapse — the facility forgets, MIMIC does not.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */

export type AdaptationKey =
  /** Reusing the same corridors and escape lines. */
  | "routeDependency"
  /** Using doors and hatches to break a chase. */
  | "doorDependency"
  /** Leaning on ECHOs as bait and decoys. */
  | "echoDependency"
  /** Making deliberate noise to move MIMIC around. */
  | "noiseDependency"
  /** Being caught in camera cones. */
  | "cameraExposure"
  /** Waiting out searches in the same alcoves. */
  | "hidingRepetition"
  /** Reaching for RETRACE under pressure. */
  | "retraceDependency";

export const ADAPTATION_KEYS: readonly AdaptationKey[] = [
  "routeDependency",
  "doorDependency",
  "echoDependency",
  "noiseDependency",
  "cameraExposure",
  "hidingRepetition",
  "retraceDependency",
];

export type AdaptationValues = Record<AdaptationKey, number>;

export const MAX_ADAPTATION = 100;

export function emptyAdaptation(): AdaptationValues {
  return {
    routeDependency: 0,
    doorDependency: 0,
    echoDependency: 0,
    noiseDependency: 0,
    cameraExposure: 0,
    hidingRepetition: 0,
    retraceDependency: 0,
  };
}

/**
 * A behaviour counter set. `note` is called from gameplay whenever the player
 * does something worth learning from; everything else reads it.
 */
export class Adaptation {
  readonly values: AdaptationValues;
  /** Keys that crossed a new whole-number band this run, for the analysis flash. */
  readonly surfaced: AdaptationKey[] = [];

  /** Guards against a held key or a per-tick condition inflating a counter. */
  private cooldowns = new Map<string, number>();

  constructor(values?: Partial<AdaptationValues>) {
    this.values = { ...emptyAdaptation(), ...values };
  }

  tick(dt: number): void {
    for (const [k, t] of this.cooldowns) {
      const next = t - dt;
      if (next <= 0) this.cooldowns.delete(k);
      else this.cooldowns.set(k, next);
    }
  }

  /**
   * Record a behaviour. `gate` throttles repeat credit for the same event so a
   * continuous condition (standing in a camera cone) cannot spike a counter.
   */
  note(key: AdaptationKey, amount: number, gate = 0, gateId: string = key): void {
    if (gate > 0) {
      if (this.cooldowns.has(gateId)) return;
      this.cooldowns.set(gateId, gate);
    }
    const before = Math.floor(this.values[key] / 25);
    this.values[key] = Math.min(MAX_ADAPTATION, this.values[key] + amount);
    // Surface a quarter-band crossing so the game can hint that something
    // changed without ever naming the ability it unlocked.
    if (Math.floor(this.values[key] / 25) > before && !this.surfaced.includes(key)) {
      this.surfaced.push(key);
    }
  }

  /** 0..1 for the given behaviour. */
  level(key: AdaptationKey): number {
    return this.values[key] / MAX_ADAPTATION;
  }

  /**
   * Overall how much MIMIC has seen, 0..1. Used as the soft tier gate so late
   * abilities cannot arrive from a single lopsided habit.
   */
  mass(): number {
    let total = 0;
    for (const k of ADAPTATION_KEYS) total += this.values[k];
    return Math.min(1, total / (MAX_ADAPTATION * 3));
  }

  /** Behaviours sorted by how strongly this player leans on them. */
  ranked(): { key: AdaptationKey; value: number }[] {
    return ADAPTATION_KEYS.map((key) => ({ key, value: this.values[key] })).sort(
      (a, b) => b.value - a.value,
    );
  }

  takeSurfaced(): AdaptationKey[] {
    const out = this.surfaced.slice();
    this.surfaced.length = 0;
    return out;
  }

  /**
   * Temporal Collapse blurs the detail but keeps the shape — the same treatment
   * the route/hide counters already get. Nothing is ever wiped.
   */
  decay(factor = 0.85): void {
    for (const k of ADAPTATION_KEYS) {
      this.values[k] = Math.round(this.values[k] * factor * 10) / 10;
    }
  }
}

/** Human-readable label for the diegetic analysis flash. */
export const ADAPTATION_LABEL: Record<AdaptationKey, string> = {
  routeDependency: "ROUTE DEPENDENCY",
  doorDependency: "ACCESS PATTERN",
  echoDependency: "REPEATED DISTRACTION PATTERN",
  noiseDependency: "ACOUSTIC SIGNATURE",
  cameraExposure: "SURVEILLANCE EXPOSURE",
  hidingRepetition: "CONCEALMENT HABIT",
  retraceDependency: "TEMPORAL DEPENDENCY",
};
