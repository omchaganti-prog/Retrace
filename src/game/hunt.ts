/**
 * HUNT MODE — a facility-wide containment protocol, not a bigger chase.
 *
 * It is always earned: a major system coming online, or MIMIC having learned
 * enough about you to escalate. Never random, never a surprise tax.
 *
 * MIMIC does not know this file exists. It reads a small bonus struct and is
 * otherwise unchanged, so Hunt Mode can be tuned or disabled without touching
 * the AI. The bonuses are deliberately unglamorous — faster, more persistent,
 * more confident. No wallhacks, no teleports, no perfect knowledge; the whole
 * point is that it stays beatable by breaking line of sight and using ECHOs.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */

export type HuntReason = "objective" | "adaptation" | "alarm";

export const HUNT = {
  /** Seconds a hunt runs. Long enough to be frightening, short enough to survive. */
  duration: 26,
  /** Seconds before another hunt may start. */
  cooldown: 70,
  /** Adaptation mass (0..1) that justifies an escalation. */
  adaptationTrigger: 0.5,
};

/** Temporary, bounded advantages. Everything here is a multiplier, never a sense. */
export interface HuntBonus {
  active: boolean;
  /** Movement multiplier. */
  speed: number;
  /** Search duration multiplier. */
  search: number;
  /** Chase persistence multiplier after losing sight. */
  persistence: number;
}

const IDLE: HuntBonus = { active: false, speed: 1, search: 1, persistence: 1 };
const HUNTING: HuntBonus = { active: true, speed: 1.18, search: 1.5, persistence: 1.4 };

export class HuntManager {
  /** Seconds left in the current hunt, 0 when inactive. */
  remaining = 0;
  /** Seconds until another hunt may be triggered. */
  cooldown = 0;
  reason: HuntReason | null = null;
  /** Set for one tick on each transition, for the presentation layer. */
  justStarted = false;
  justEnded = false;
  /** How many hunts this session — used to keep announcements from repeating. */
  count = 0;

  get active(): boolean {
    return this.remaining > 0;
  }

  /** 0..1 through the current hunt, for lighting ramps. */
  get progress(): number {
    return this.active ? 1 - this.remaining / HUNT.duration : 0;
  }

  get bonus(): HuntBonus {
    return this.active ? HUNTING : IDLE;
  }

  /** True when a hunt could legitimately start right now. */
  canStart(): boolean {
    return !this.active && this.cooldown <= 0;
  }

  start(reason: HuntReason): boolean {
    if (!this.canStart()) return false;
    this.remaining = HUNT.duration;
    this.reason = reason;
    this.justStarted = true;
    this.count++;
    return true;
  }

  /** Ends early — used when the run restarts under the player's feet. */
  stop(): void {
    if (this.active) this.justEnded = true;
    this.remaining = 0;
    this.reason = null;
  }

  /** A run reset clears the emergency but keeps the cooldown honest. */
  resetForRun(): void {
    this.remaining = 0;
    this.reason = null;
    this.justStarted = false;
    this.justEnded = false;
  }

  /**
   * Clears the one-tick flags. Called at the very end of the simulation tick,
   * like the sound and ECHO buses — clearing them at the *start* meant a hunt
   * started earlier in the same tick was already invisible by the time anything
   * outside the Game could observe it.
   */
  endTick(): void {
    this.justStarted = false;
    this.justEnded = false;
  }

  tick(dt: number): void {
    if (this.remaining > 0) {
      this.remaining -= dt;
      if (this.remaining <= 0) {
        this.remaining = 0;
        this.reason = null;
        this.justEnded = true;
        this.cooldown = HUNT.cooldown;
      }
      return;
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
  }
}
