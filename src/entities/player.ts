/**
 * Subject 047.
 *
 * Movement is acceleration-based but capped per mode, so the recording that
 * becomes an ECHO is a smooth path rather than a stutter of input samples.
 * Footsteps are emitted on a timer rather than per step of animation — the
 * interval is what makes sprinting genuinely louder to MIMIC, not just faster.
 *
 * Sprint and dash draw on one shared stamina pool, so movement is a budget
 * rather than two independent cooldowns. The dash charges while held and fires
 * along whatever you are facing, which makes turning mid-charge the way you aim.
 */
import { DASH, PLAYER, STAMINA, TILE } from "../core/constants";
import { type Dir, clamp, dirFromVector, dirVector } from "../core/math";
import type { InputSnapshot } from "../core/input";
import { moveCircle } from "../systems/collide";
import type { Level } from "../world/level";

/**
 * What the smallest dash that actually launches costs. Anything under this and
 * the wind-up could only reach a charge too short to fire, so it is refused up
 * front — a held key that silently does nothing reads as a broken button.
 */
const MIN_DASH_COST = DASH.costMin + (DASH.costMax - DASH.costMin) * DASH.minCharge;

export interface PlayerStep {
  /** True on the tick a footstep noise should be emitted. */
  stepped: boolean;
  /** True on the tick stamina ran out, so the HUD can call it out once. */
  justExhausted: boolean;
  /** True on the tick a dash launched — the loud one MIMIC hears. */
  dashed: boolean;
  /** True on the tick a dash was refused for lack of stamina. */
  dashFailed: boolean;
  /** Rising tick while charging, for the wind-up cue. */
  charging: boolean;
}

export class Player {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  dir: Dir = 0;
  moving = false;
  sprinting = false;
  /**
   * Creeping. Costs no stamina — the price is the clock. It is the counterpart
   * to sprinting rather than a weaker walk: sprint buys distance and spends
   * both stamina and silence, sneak buys silence and spends time.
   */
  sneaking = false;
  /** Seconds since the last footstep emission. */
  private stepT = 0;
  /** Seconds spent continuously standing in an unlit tile. */
  shadowT = 0;

  /** Remaining stamina, 0..STAMINA.max. Shared by sprint and dash. */
  stamina = STAMINA.max;
  /** Spent out completely; movement abilities lock until STAMINA.unlockAt. */
  exhausted = false;
  /** Seconds left before stamina starts refilling. */
  private regenT = 0;
  /**
   * Set when the pool empties under a held sprint key. Without it, stamina
   * climbs to the unlock threshold and the sprint immediately re-engages,
   * stuttering on and off forever — you must let go and rest.
   */
  private sprintLock = false;
  /** Stops the refusal cue machine-gunning while the dash key stays held. */
  private dashRefused = false;

  /** 0..1 wind-up while Space is held. */
  charge = 0;
  charging = false;
  /** 0..1 — how much of the bar the last launched dash cost. Drives the kick. */
  staminaSpentOnDash = 0;
  /** Seconds left of the dash burst. */
  private dashT = 0;
  /** Seconds until another dash may start. */
  private dashCd = 0;
  private dashVX = 0;
  private dashVY = 0;
  /** True while the burst is travelling — drives the trail art. */
  get dashing(): boolean {
    return this.dashT > 0;
  }

  /** 0..1, for the HUD meter. */
  get staminaFraction(): number {
    return this.stamina / STAMINA.max;
  }

  /**
   * How far the wind-up can go on the stamina in hand. A half-empty meter
   * charges to a smaller dash rather than filling up and then being refused —
   * what you can afford is what you get.
   */
  get maxCharge(): number {
    return clamp((this.stamina - DASH.costMin) / (DASH.costMax - DASH.costMin), 0, 1);
  }

  /** What the pending dash would cost right now. */
  get chargeCost(): number {
    return DASH.costMin + (DASH.costMax - DASH.costMin) * this.charge;
  }

  /** How far the pending dash would travel, in pixels. */
  get chargeDistance(): number {
    return DASH.distanceMin + (DASH.distanceMax - DASH.distanceMin) * this.charge;
  }

  reset(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.dir = 0;
    this.moving = false;
    this.sprinting = false;
    this.sneaking = false;
    this.stepT = 0;
    this.shadowT = 0;
    // A new run is a fresh body — starting a retrace winded would punish the
    // one thing the game wants you to do freely.
    this.stamina = STAMINA.max;
    this.exhausted = false;
    this.regenT = 0;
    this.sprintLock = false;
    this.dashRefused = false;
    this.staminaSpentOnDash = 0;
    this.charge = 0;
    this.charging = false;
    this.dashT = 0;
    this.dashCd = 0;
  }

  update(dt: number, level: Level, input: InputSnapshot | null): PlayerStep {
    const out: PlayerStep = {
      stepped: false,
      justExhausted: false,
      dashed: false,
      dashFailed: false,
      charging: false,
    };

    this.dashCd = Math.max(0, this.dashCd - dt);

    // The burst overrides everything: no steering, no input, just travel until
    // it expires or a wall stops it.
    if (this.dashT > 0) {
      this.dashT -= dt;
      // moveCircle only tests the tile it lands in, so a burst this fast has to
      // be walked in bites thinner than a wall or it would pass straight through.
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(this.dashVX * dt, this.dashVY * dt) / (TILE / 3)),
      );
      let bx = (this.dashVX * dt) / steps;
      let by = (this.dashVY * dt) / steps;
      for (let i = 0; i < steps && (bx !== 0 || by !== 0); i++) {
        const moved = moveCircle(level, this.x, this.y, PLAYER.radius, bx, by);
        this.x = moved.x;
        this.y = moved.y;
        if (moved.hitX) {
          this.dashVX = 0;
          bx = 0;
        }
        if (moved.hitY) {
          this.dashVY = 0;
          by = 0;
        }
      }
      this.moving = true;
      this.sprinting = false;
      // Carry a little speed out of the burst so it does not stop dead.
      this.vx = this.dashVX * 0.25;
      this.vy = this.dashVY * 0.25;
      this.regen(dt, false);
      return out;
    }

    let ix = 0;
    let iy = 0;
    if (input) {
      if (input.left) ix -= 1;
      if (input.right) ix += 1;
      if (input.up) iy -= 1;
      if (input.down) iy += 1;
    }
    const mag = Math.hypot(ix, iy);
    // Face the input while steering; the dash then fires wherever you are aimed.
    if (mag > 0) this.dir = dirFromVector(ix, iy, this.dir);

    out.charging = this.updateCharge(dt, Boolean(input?.dash), out);

    // Sprint wins when both are held. It is the panic input, and a player
    // mashing keys to escape should never creep by accident.
    const wantsSprint = Boolean(input?.sprint) && mag > 0;
    this.sneaking = !wantsSprint && Boolean(input?.sneak) && !this.dashing;

    const justExhausted = this.updateSprint(dt, wantsSprint);
    out.justExhausted = justExhausted;

    let speed = this.sprinting
      ? PLAYER.sprintSpeed
      : this.sneaking
        ? PLAYER.sneakSpeed
        : PLAYER.walkSpeed;
    // Winding up commits you — it is slow, which is the price of the burst.
    if (this.charging) speed *= DASH.chargeSlow;

    let targetVx = 0;
    let targetVy = 0;
    if (mag > 0) {
      targetVx = (ix / mag) * speed;
      targetVy = (iy / mag) * speed;
    }

    // Approach the target velocity at a fixed acceleration; stopping uses the
    // same rate, which keeps the recorded path free of overshoot.
    const step = PLAYER.accel * dt;
    this.vx += Math.max(-step, Math.min(step, targetVx - this.vx));
    this.vy += Math.max(-step, Math.min(step, targetVy - this.vy));

    const moved = moveCircle(level, this.x, this.y, PLAYER.radius, this.vx * dt, this.vy * dt);
    this.x = moved.x;
    this.y = moved.y;
    if (moved.hitX) this.vx = 0;
    if (moved.hitY) this.vy = 0;

    this.moving = Math.hypot(this.vx, this.vy) > 6;

    if (this.moving) {
      this.stepT += dt;
      const interval = this.sprinting
        ? PLAYER.stepIntervalSprint
        : this.sneaking
          ? PLAYER.stepIntervalSneak
          : PLAYER.stepIntervalWalk;
      if (this.stepT >= interval) {
        this.stepT = 0;
        out.stepped = true;
      }
    } else {
      // Land the next step promptly when starting to move again.
      this.stepT = Math.min(this.stepT, PLAYER.stepIntervalWalk * 0.6);
    }

    this.regen(dt, this.sprinting || this.charging);
    return out;
  }

  /**
   * Hold to wind up, release to commit. A charge too short to matter is treated
   * as a mis-tap and costs nothing, so brushing the key is never punished.
   */
  private updateCharge(dt: number, held: boolean, out: PlayerStep): boolean {
    if (!held) this.dashRefused = false;

    if (held) {
      if (this.dashCd > 0) return false;
      // Refuse up front rather than letting a charge build with nothing to spend.
      if (this.exhausted || this.stamina < MIN_DASH_COST) {
        // One refusal per press — holding the key must not machine-gun the cue.
        if (!this.dashRefused) {
          out.dashFailed = true;
          this.dashRefused = true;
        }
        this.charging = false;
        this.charge = 0;
        return false;
      }
      this.charging = true;
      // The ceiling is whatever the pool can pay for, so the wind-up visibly
      // tops out early when you are low instead of promising a dash you cannot buy.
      this.charge = Math.min(this.maxCharge, this.charge + dt / DASH.chargeSeconds);
      return true;
    }

    if (!this.charging) return false;
    this.charging = false;

    // Sprinting through the wind-up can eat the pool after the charge capped;
    // trim to what is still affordable rather than refusing outright.
    this.charge = Math.min(this.charge, this.maxCharge);

    if (this.charge < DASH.minCharge) {
      // A brush of the key costs nothing. A real wind-up whose funding drained
      // away mid-hold says so, rather than fizzling without explanation.
      if (this.charge > 0 && this.stamina < MIN_DASH_COST) {
        out.dashFailed = true;
        this.dashRefused = true;
      }
      this.charge = 0;
      return false;
    }

    const cost = this.chargeCost;

    // Launch along the facing, at whatever the charge bought.
    const v = dirVector(this.dir);
    const speed = this.chargeDistance / DASH.duration;
    this.dashVX = v.x * speed;
    this.dashVY = v.y * speed;
    this.dashT = DASH.duration;
    this.dashCd = DASH.duration + DASH.recovery;
    this.staminaSpentOnDash = cost / STAMINA.max;
    this.spend(cost);
    this.charge = 0;
    out.dashed = true;
    return false;
  }

  /** Resolves whether the sprint key actually produces a sprint this tick. */
  private updateSprint(dt: number, wantsSprint: boolean): boolean {
    if (!wantsSprint) this.sprintLock = false;
    this.sprinting = wantsSprint && !this.sprintLock && !this.exhausted && this.stamina > 0;
    if (!this.sprinting) return false;

    this.spend(STAMINA.sprintDrain * dt);
    if (this.stamina <= 0) {
      this.sprinting = false;
      this.sprintLock = true;
      return true;
    }
    return false;
  }

  private spend(amount: number): void {
    this.stamina = clamp(this.stamina - amount, 0, STAMINA.max);
    this.regenT = STAMINA.regenDelay;
    if (this.stamina <= 0) this.exhausted = true;
  }

  /**
   * Refills after a delay from the last spend. Runs even while the keys are
   * still held down — being winded with your finger on shift should recover.
   */
  private regen(dt: number, spending: boolean): void {
    if (spending) return;
    this.regenT = Math.max(0, this.regenT - dt);
    if (this.regenT > 0) return;
    this.stamina = clamp(this.stamina + STAMINA.regenRate * dt, 0, STAMINA.max);
    if (this.exhausted && this.stamina >= STAMINA.unlockAt) this.exhausted = false;
  }
}
