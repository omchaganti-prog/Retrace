/**
 * MIMIC's adaptation system: system power, cooldowns, and the manager that
 * decides which counter-measure to spend it on.
 *
 * Abilities *supplement* the existing state machine — they never replace it.
 * MIMIC still patrols, investigates, chases and searches exactly as before; an
 * ability can steer that behaviour (send it to an intercept point, hold it still
 * for a scan) or reach into the facility (seal a door, read a camera), but the
 * state machine keeps running underneath.
 *
 * Every ability here obeys two hard rules:
 *   - It never grants information the level would not legitimately give. No
 *     wallhacks, no omniscience; sight still goes through the LOS raycaster and
 *     cameras only report what their own cones catch.
 *   - It has counterplay. If a player cannot do anything about it, it does not
 *     belong in this file.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import type { Rng } from "../core/rng";
import type { SensedEcho } from "../entities/mimic";
import type { MimicMemory } from "../systems/memory";
import type { SoundKind } from "../systems/sound";
import type { Strategy } from "../systems/strategist";
import type { Level } from "../world/level";
import type { Adaptation, AdaptationKey } from "./adaptation";

export type AbilityId =
  | "focus_scan"
  | "sound_analysis"
  | "route_prediction"
  | "door_control"
  | "camera_link"
  | "echo_analysis"
  | "intercept"
  | "power_surge"
  | "deep_scan"
  | "facility_override";

export type AbilityTier = "early" | "mid" | "late";

/* --------------------------------------------------------------- tuning */

/** Central tuning table. Everything spendable or timed lives here. */
export const POWER = {
  max: 100,
  /** Units regenerated per second while idle. */
  regen: 4.2,
  /** Regeneration is slower while actively hunting — spending has a cost. */
  chaseRegenScale: 0.55,
  /** Seconds after any activation before another may start. */
  globalGap: 2.5,
  /** Below this fraction the eye visibly dims and flickers. */
  lowFraction: 0.3,
};

/**
 * How much priority a ready-but-passed-over ability gains each decision, and the
 * ceiling on that. Small enough that the intended ordering still holds most of
 * the time; large enough that nothing sits at the bottom of the ladder forever.
 */
const PATIENCE_STEP = 6;
const PATIENCE_CAP = 45;

export interface AbilityTuning {
  name: string;
  tier: AbilityTier;
  /** Which behaviour teaches MIMIC this counter-measure. */
  driver: AdaptationKey;
  /** Driver level (0..1) at which it develops. */
  unlockAt: number;
  /** Total adaptation mass (0..1) gating the tier, so late arrivals stay late. */
  massGate: number;
  cost: number;
  cooldown: number;
  /** Higher wins when several are ready at once. */
  priority: number;
  /** What the player can do about it — documentation that ships with the code. */
  counterplay: string;
}

export const ABILITY_TUNING: Record<AbilityId, AbilityTuning> = {
  focus_scan: {
    name: "FOCUS SCAN",
    tier: "early",
    driver: "hidingRepetition",
    unlockAt: 0.04,
    massGate: 0,
    cost: 15,
    cooldown: 15,
    priority: 20,
    counterplay: "Move while it scans; it holds still and still cannot see through walls.",
  },
  sound_analysis: {
    name: "SOUND ANALYSIS",
    tier: "early",
    driver: "noiseDependency",
    unlockAt: 0.18,
    massGate: 0,
    cost: 0,
    cooldown: 0,
    priority: 0,
    counterplay: "Vary timing and location; stack real noise with ECHO noise.",
  },
  route_prediction: {
    name: "ROUTE PREDICTION",
    tier: "mid",
    driver: "routeDependency",
    unlockAt: 0.35,
    massGate: 0.18,
    cost: 20,
    cooldown: 16,
    priority: 40,
    counterplay: "Start down a familiar route, then break off. Let an ECHO take it instead.",
  },
  door_control: {
    name: "DOOR CONTROL",
    tier: "mid",
    driver: "doorDependency",
    unlockAt: 0.28,
    massGate: 0.18,
    cost: 25,
    cooldown: 22,
    priority: 55,
    counterplay: "Locks are temporary; take another route, or bait it into sealing a door on an ECHO.",
  },
  camera_link: {
    name: "CAMERA LINK",
    tier: "mid",
    driver: "cameraExposure",
    unlockAt: 0.3,
    massGate: 0.18,
    cost: 20,
    cooldown: 14,
    priority: 30,
    counterplay: "Stay out of camera cones, or walk an ECHO through one to feed it a lie.",
  },
  echo_analysis: {
    name: "ECHO ANALYSIS",
    tier: "mid",
    driver: "echoDependency",
    unlockAt: 0.4,
    massGate: 0.2,
    cost: 0,
    cooldown: 0,
    priority: 0,
    counterplay: "Record a new route. A pattern it has not seen is fully effective again.",
  },
  intercept: {
    name: "INTERCEPT",
    tier: "late",
    driver: "routeDependency",
    unlockAt: 0.62,
    massGate: 0.4,
    cost: 30,
    cooldown: 26,
    priority: 60,
    counterplay: "Double back, change destination, or send an ECHO down the expected line.",
  },
  power_surge: {
    name: "POWER SURGE",
    tier: "late",
    driver: "cameraExposure",
    unlockAt: 0.6,
    massGate: 0.4,
    cost: 35,
    cooldown: 34,
    priority: 35,
    counterplay: "It is temporary, and it blinds the zone's own cameras while it runs.",
  },
  deep_scan: {
    name: "DEEP SCAN",
    tier: "late",
    driver: "hidingRepetition",
    unlockAt: 0.65,
    massGate: 0.45,
    cost: 40,
    cooldown: 38,
    priority: 45,
    counterplay: "Hold still, or leave the sector. It reads disturbances, never positions.",
  },
  facility_override: {
    name: "FACILITY OVERRIDE",
    tier: "late",
    driver: "retraceDependency",
    unlockAt: 0.7,
    massGate: 0.55,
    cost: 60,
    cooldown: 55,
    priority: 70,
    counterplay: "It is slowed and half-blind while connected. Bait it, then move.",
  },
};

/* -------------------------------------------------------------- effects */

/**
 * Every ability needs its own silhouette.
 *
 * Three pairs used to share a shape — door control looked exactly like camera
 * link, intercept like route prediction, facility override like a power surge —
 * which made "learn to read what it is about to do" impossible by construction.
 * One kind per ability, each drawn differently.
 */
export type MimicFxKind =
  | "scan"
  | "pulse"
  | "link"
  | "surge"
  | "deep"
  | "predict"
  /** Door control: a bolt thrown down a line. */
  | "lock"
  /** Intercept: a wedge committing to a chokepoint ahead of you. */
  | "intercept"
  /** Facility override: the whole system answering at once. */
  | "override";

/** A transient visual the renderer draws. Abilities must announce themselves. */
export interface MimicFx {
  kind: MimicFxKind;
  x: number;
  y: number;
  /** Target point for link/predict lines. */
  toX?: number;
  toY?: number;
  radius: number;
  age: number;
  life: number;
}

export interface CameraSighting {
  cameraId: string;
  x: number;
  y: number;
  /** What the camera thinks it saw. Cameras cannot tell a copy from the original. */
  target: "player" | "echo";
  /** 0..1 — how sure MIMIC is this is the living subject. */
  confidence: number;
}

/** Something that happened recently and left a trace, for Deep Scan. */
export interface Disturbance {
  x: number;
  y: number;
  /** 0..1 strength, decaying with age. */
  strength: number;
  source: "player" | "echo" | "world";
}

/** The facility, as far as an ability is allowed to touch it. */
export interface AbilityWorld {
  readonly level: Level;
  /** Seal a MIMIC-controllable door. Returns false when refused. */
  lockDoor(doorId: string, seconds: number): boolean;
  /** Doors it is currently permitted to seal without stranding the player. */
  lockableDoors(): string[];
  /** Temporarily disrupt a zone's lighting and surveillance. */
  surgeZone(zoneId: string, seconds: number): void;
  /** What the facility's own cameras reported this tick. */
  cameraSightings(): CameraSighting[];
  /** Recent disturbances near a point, strongest first. */
  disturbancesNear(x: number, y: number, radius: number): Disturbance[];
  notice(text: string): void;
  log(text: string): void;
  play(kind: SoundKind, volume: number): void;
  emitFx(fx: Omit<MimicFx, "age">): void;
}

export interface AbilityCtx {
  dt: number;
  /** Live MIMIC. Abilities steer it through its public command surface only. */
  mimic: AbilityMimic;
  adaptation: Adaptation;
  memory: MimicMemory;
  strategy: Strategy;
  rng: Rng;
  player: { x: number; y: number; hidden: boolean; zone: string | null };
  /** Whether MIMIC has *confirmed* the living player right now. */
  playerConfirmed: boolean;
  echoes: SensedEcho[];
  world: AbilityWorld;
}

/**
 * The slice of MIMIC an ability may touch. Narrower than the class on purpose —
 * abilities steer, they do not reach inside the state machine.
 */
export interface AbilityMimic {
  x: number;
  y: number;
  facing: number;
  state: string;
  lastKnown: { x: number; y: number } | null;
  unseenT: number;
  /** Seconds it will stand still. Set by scanning abilities. */
  holdT: number;
  /** Reduced awareness while connected to a subsystem, 0..1. */
  distracted: number;
  commandGoal(x: number, y: number): void;
  beginIntercept(x: number, y: number, seconds: number): void;
  investigateAt(x: number, y: number): void;
}

export interface Ability {
  readonly id: AbilityId;
  /** Can it fire right now? Cost, cooldown and unlock are checked by the manager. */
  ready(ctx: AbilityCtx): boolean;
  /** Fire it. Returns how long it stays active, in seconds (0 for instant). */
  activate(ctx: AbilityCtx): number;
  /** Per-tick while active. */
  update?(ctx: AbilityCtx, elapsed: number): void;
  end?(ctx: AbilityCtx): void;
  /** Per-tick regardless of activation — for the always-on analysis passives. */
  passive?(ctx: AbilityCtx): void;
}

/* -------------------------------------------------------------- manager */

export interface AbilityState {
  unlocked: boolean;
  /** 0..1 toward developing it. */
  progress: number;
  cooldown: number;
  lastUsedAt: number;
}

export class AbilityManager {
  power: number = POWER.max;
  /** Set for a moment after a big spend, so the eye can look drained. */
  drain = 0;
  active: { id: AbilityId; t: number; total: number } | null = null;
  lastUsed: AbilityId | null = null;
  /** Set for one tick when an ability fires, for logging and tells. */
  justFired: AbilityId | null = null;

  private readonly states = new Map<AbilityId, AbilityState>();
  private gap = 0;

  constructor(
    private readonly abilities: Map<AbilityId, Ability>,
    unlocked: AbilityId[] = [],
  ) {
    for (const id of this.abilities.keys()) {
      this.states.set(id, {
        unlocked: unlocked.includes(id),
        progress: unlocked.includes(id) ? 1 : 0,
        cooldown: 0,
        lastUsedAt: -999,
      });
    }
  }

  state(id: AbilityId): AbilityState {
    return this.states.get(id) ?? { unlocked: false, progress: 0, cooldown: 0, lastUsedAt: -999 };
  }

  isUnlocked(id: AbilityId): boolean {
    return this.state(id).unlocked;
  }

  /**
   * True while a developed counter-measure has been spent and cannot fire again
   * yet. This is deliberately public: baiting MIMIC into wasting an override on
   * a route you were never going to take is a puzzle solution, and the facility
   * exposes the resulting gap as a signal the player can walk through.
   */
  onCooldown(id: AbilityId): boolean {
    const s = this.state(id);
    return s.unlocked && s.cooldown > 0;
  }

  unlockedIds(): AbilityId[] {
    return [...this.states.entries()].filter(([, s]) => s.unlocked).map(([id]) => id);
  }

  get powerFraction(): number {
    return this.power / POWER.max;
  }

  /** A new run: clear transient activity but keep everything learned. */
  resetForRun(): void {
    this.power = POWER.max;
    this.active = null;
    this.drain = 0;
    this.gap = 0;
    this.justFired = null;
    for (const s of this.states.values()) s.cooldown = 0;
    this.waiting.clear();
  }

  /**
   * Grow unlock progress from the behaviour counters. An ability develops when
   * the habit that counters it is strong enough *and* MIMIC has seen enough
   * overall — so the order really does depend on how the player plays, while
   * late-tier tools still stay late.
   */
  advanceUnlocks(adaptation: Adaptation, elapsed: number): AbilityId[] {
    const developed: AbilityId[] = [];
    for (const [id, s] of this.states) {
      if (s.unlocked) continue;
      const t = ABILITY_TUNING[id];
      if (adaptation.mass() < t.massGate) continue;
      const driver = adaptation.level(t.driver);
      s.progress = Math.min(1, driver / t.unlockAt);
      if (s.progress >= 1) {
        s.unlocked = true;
        s.lastUsedAt = elapsed;
        developed.push(id);
      }
    }
    return developed;
  }

  update(ctx: AbilityCtx, elapsed: number): void {
    this.justFired = null;
    const dt = ctx.dt;

    // Hunting costs more than it earns back, so a chase drains MIMIC over time.
    const hunting = ctx.mimic.state === "chase" || ctx.mimic.state === "intercept";
    this.power = Math.min(
      POWER.max,
      this.power + POWER.regen * dt * (hunting ? POWER.chaseRegenScale : 1),
    );
    this.drain = Math.max(0, this.drain - dt * 0.8);
    this.gap = Math.max(0, this.gap - dt);
    for (const s of this.states.values()) s.cooldown = Math.max(0, s.cooldown - dt);

    // Always-on analysis runs whether or not an ability is mid-activation.
    for (const [id, ability] of this.abilities) {
      if (ability.passive && this.states.get(id)?.unlocked) ability.passive(ctx);
    }

    if (this.active) {
      const ability = this.abilities.get(this.active.id);
      const done = (this.active.t -= dt) <= 0;
      ability?.update?.(ctx, this.active.total - Math.max(0, this.active.t));
      if (done) {
        ability?.end?.(ctx);
        this.active = null;
      }
      return;
    }

    if (this.gap > 0) return;

    const pick = this.choose(ctx);
    if (!pick) return;

    const t = ABILITY_TUNING[pick.id];
    const s = this.states.get(pick.id)!;
    const duration = pick.activate(ctx);
    this.power -= t.cost;
    this.drain = Math.min(1, t.cost / POWER.max + 0.15);
    s.cooldown = t.cooldown;
    s.lastUsedAt = elapsed;
    this.gap = POWER.globalGap;
    this.lastUsed = pick.id;
    this.justFired = pick.id;
    if (duration > 0) this.active = { id: pick.id, t: duration, total: duration };
  }

  /**
   * Why each ability was passed over on the last decision.
   *
   * Diagnostics, not behaviour. An ability the player never sees is content that
   * does not exist, and "it never fires" is impossible to act on without knowing
   * whether it was locked, broke, unaffordable, or simply outranked every single
   * time. This makes that visible in the debug overlay.
   */
  readonly lastRejections = new Map<AbilityId, string>();
  /** Accrued impatience per ability, reset when it finally fires. */
  private readonly waiting = new Map<AbilityId, number>();

  /**
   * Picks the counter-measure to spend power on.
   *
   * Priority decides ties, but it is *aged*: an ability that has been ready and
   * passed over accrues a small bonus each time. Without that, a fixed ladder
   * means a low-priority ability can only fire when every ability above it is
   * simultaneously on cooldown — which for route prediction, sitting under four
   * others, was close to never. Ageing costs nothing when only one is ready and
   * guarantees the whole roster eventually surfaces.
   */
  private choose(ctx: AbilityCtx): Ability | null {
    let best: Ability | null = null;
    let bestScore = -1;
    this.lastRejections.clear();

    for (const [id, ability] of this.abilities) {
      const s = this.states.get(id)!;
      const t = ABILITY_TUNING[id];

      if (t.cost <= 0) continue; // passive analysis; never "activates"
      if (!s.unlocked) {
        this.lastRejections.set(id, "locked");
        continue;
      }
      if (s.cooldown > 0) {
        this.lastRejections.set(id, `cooldown ${s.cooldown.toFixed(1)}s`);
        continue;
      }
      if (this.power < t.cost) {
        this.lastRejections.set(id, `power ${Math.round(this.power)}/${t.cost}`);
        continue;
      }
      if (!ability.ready(ctx)) {
        this.lastRejections.set(id, "conditions unmet");
        this.waiting.set(id, 0);
        continue;
      }

      // Ready but not chosen last time? It has been waiting.
      const patience = this.waiting.get(id) ?? 0;
      const score = t.priority + patience;
      if (score <= bestScore) {
        this.lastRejections.set(id, `outranked (${score.toFixed(0)})`);
        continue;
      }
      if (best) this.lastRejections.set(best.id, "outranked");
      best = ability;
      bestScore = score;
    }

    // Everything that was ready and lost gets more impatient; the winner resets.
    for (const [id] of this.abilities) {
      const reason = this.lastRejections.get(id);
      if (reason?.startsWith("outranked")) {
        this.waiting.set(id, Math.min(PATIENCE_CAP, (this.waiting.get(id) ?? 0) + PATIENCE_STEP));
      }
    }
    if (best) this.waiting.set(best.id, 0);

    return best;
  }
}
