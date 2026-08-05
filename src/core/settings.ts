/**
 * Player-facing settings.
 *
 * Accessibility is not bolted on at the end here. RETRACE leans hard on flashing
 * emergency lighting, screen corruption and camera kick to communicate danger,
 * and every one of those is something a real person may be unable to tolerate.
 * So each has a dial — and, more importantly, the *information* each one carries
 * survives being turned off: Hunt Mode still announces itself in text, in the
 * log, in the music and in MIMIC's behaviour, not only in the strobing border.
 *
 * Defaults follow the operating system where it has an opinion, so a player who
 * has already asked for reduced motion never has to find a menu.
 */

export type Intensity = "off" | "reduced" | "normal";

const SCALE: Record<Intensity, number> = { off: 0, reduced: 0.45, normal: 1 };

export type EffectKey = "screenShake" | "glitch" | "flashing";

export class Settings {
  masterVolume = 0.55;
  musicVolume = 0.85;
  sfxVolume = 1;

  /** Camera kick on impacts. */
  screenShake: Intensity = "normal";
  /** Corruption, channel split and static from lost stability. */
  glitch: Intensity = "normal";
  /** Emergency lighting pulses and the alert strobe. */
  flashing: Intensity = "normal";

  /**
   * Whether MIMIC's footsteps are audible.
   *
   * Off by design choice, not by accident. Hearing the hunter walking around is
   * a legitimate stealth-audio idea, but it also means a near-constant mechanical
   * tick under everything else — and RETRACE wants its quiet moments genuinely
   * quiet, so that a noise means something. Flip to true to restore it.
   */
  mimicFootsteps = false;

  /** Multiplier for an effect, 0 when disabled. */
  scale(which: EffectKey): number {
    return SCALE[this[which]];
  }

  /**
   * Adopts the system motion preference. Only ever *reduces* — a player who has
   * explicitly asked for full effects is not overruled on the next frame.
   */
  applySystemPreferences(reducedMotion: boolean): void {
    if (!reducedMotion) return;
    this.screenShake = "off";
    this.flashing = "reduced";
    this.glitch = "reduced";
  }

  cycle(which: EffectKey): Intensity {
    const order: Intensity[] = ["normal", "reduced", "off"];
    this[which] = order[(order.indexOf(this[which]) + 1) % order.length];
    return this[which];
  }

  /** One line per row, for the pause screen. */
  lines(): string[] {
    return [
      `[1] SCREEN SHAKE      ${this.screenShake.toUpperCase()}`,
      `[2] GLITCH INTENSITY  ${this.glitch.toUpperCase()}`,
      `[3] FLASHING EFFECTS  ${this.flashing.toUpperCase()}`,
      `[4] MIMIC FOOTSTEPS   ${this.mimicFootsteps ? "ON" : "OFF"}`,
      `[M] AUDIO             ${this.masterVolume > 0 ? "ON" : "MUTED"}`,
    ];
  }
}
