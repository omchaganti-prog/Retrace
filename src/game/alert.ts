/**
 * Facility alert state — the building's own reaction, separate from MIMIC's.
 *
 * Owns the emergency lighting ramp, the strobe, and the announcement queue, so
 * the renderer and HUD read one number each instead of inferring the facility's
 * mood from AI internals.
 *
 * Accessibility is a first-class constraint here, not a setting bolted on: the
 * strobe is a slow sine rather than a flash, and `reducedFlashing` (wired to
 * prefers-reduced-motion) flattens it to a steady glow that carries the same
 * information without the flicker.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */

export interface Announcement {
  text: string;
  t: number;
}

/** Seconds an announcement stays on screen. */
const ANNOUNCE_TIME = 2.6;
/** Minimum gap between announcements, so they never chatter. */
const ANNOUNCE_GAP = 4;

export class AlertManager {
  /** 0..1 emergency lighting level. Ramps, never snaps. */
  emergency = 0;
  /** 0..1 strobe brightness, derived from `emergency`. */
  strobe = 0;
  /** Honour the OS reduced-motion preference; flattens the strobe. */
  reducedFlashing = false;

  current: Announcement | null = null;
  private queue: string[] = [];
  private gap = 0;
  private phase = 0;

  /** Queue a short facility announcement. Duplicates are dropped. */
  announce(text: string): void {
    if (this.current?.text === text || this.queue.includes(text)) return;
    this.queue.push(text);
    if (this.queue.length > 3) this.queue.shift();
  }

  reset(): void {
    this.emergency = 0;
    this.strobe = 0;
    this.current = null;
    this.queue.length = 0;
    this.gap = 0;
  }

  /**
   * `wanted` is the target emergency level — 1 during a hunt, lower for a local
   * alarm, 0 normally. The ramp is asymmetric: the facility panics faster than
   * it calms down.
   */
  update(dt: number, wanted: number): void {
    const rate = wanted > this.emergency ? 2.2 : 0.5;
    const delta = wanted - this.emergency;
    this.emergency += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);

    this.phase += dt * 2.4;
    // A slow swell rather than a flash. Reduced-motion gets a steady glow.
    const wave = this.reducedFlashing ? 0.75 : 0.55 + 0.45 * Math.sin(this.phase);
    this.strobe = this.emergency * wave;

    this.gap = Math.max(0, this.gap - dt);
    if (this.current) {
      this.current.t -= dt;
      if (this.current.t <= 0) this.current = null;
    }
    if (!this.current && this.gap <= 0 && this.queue.length > 0) {
      this.current = { text: this.queue.shift()!, t: ANNOUNCE_TIME };
      this.gap = ANNOUNCE_GAP;
    }
  }
}
