/**
 * Adaptive music.
 *
 * Seven stems of ONE composition, loaded from `public/audio/music/`. They are
 * all started at a single shared timestamp and then never touched again —
 * looping `AudioBufferSourceNode`s driven by the same clock cannot drift, so
 * synchronisation is a structural guarantee rather than something maintained.
 *
 * Intensity only moves gains. Nothing is ever stopped, restarted or re-seeked,
 * which is what makes every transition a crossfade instead of a cut.
 *
 * Replacing the placeholder audio requires no code change: drop files matching
 * COMPOSITION into the music folder. See `manifest.ts` for the contract.
 *
 * The intensity model is pure and advances on the tick clock, so the whole
 * arrangement is testable under Node with no audio at all.
 */
import {
  BAR_SECONDS,
  LOOP_SECONDS,
  type StemId,
  STEMS,
  STEM_IDS,
} from "./manifest";
import { type LoadedStems, loadStems } from "./loader";

export { COMPOSITION, LOOP_SECONDS, type StemId, STEMS, STEM_IDS } from "./manifest";
/** Back-compat alias: the stem ids, in arrangement order. */
export const MUSIC_STEMS = STEM_IDS;

/** What the simulation tells the score each tick. */
export interface ThreatSnapshot {
  /** Straight-line distance to MIMIC, in tiles. Walls do not mute proximity. */
  distanceTiles: number;
  hasLineOfSight: boolean;
  /** Detection confirmed — the RETRACE jam is up. */
  detected: boolean;
  chasing: boolean;
  hunting: boolean;
  /** 0..1 from lost Temporal Stability. */
  corruption: number;
}

/* ------------------------------------------------------------------ tuning */

/** The score never fades out; at its calmest it sits at the edge of hearing. */
const QUIET_LEVEL = 0.3;
const LOUD_LEVEL = 1;
/** Filter floor, high enough that quiet passages are music and not rumble. */
const MIN_CUTOFF_HZ = 700;

const RISE_PER_SECOND = 2.6;
const FALL_PER_SECOND = 0.22;
const RELEASE_HOLD_SECONDS = 1.6;
const SIGHTED_RISE_BONUS = 1.8;

/** Seconds a stem takes to fade in / out. Entering is quick; leaving is not. */
const FADE_IN = 0.9;
const FADE_OUT = 2.4;
/** Hysteresis so a stem parked on its threshold does not chatter. */
const ENTRY_HYSTERESIS = 0.35;

const SMOOTH = { levelUp: 0.12, levelDown: 0.7, filterOpen: 0.2, filterClose: 1.1 };

interface Stem {
  id: StemId;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  /** Smoothed 0..1 mix level. Advances with or without audio. */
  level: number;
  target: number;
}

export class MusicManager {
  /** Smoothed 0..5. Read by the HUD and tests. */
  intensity = 0;
  muted = false;

  private target = 0;
  private corruption = 0;
  private warp = 0;
  private collapsed = false;
  private releaseHold = 0;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private glitch: GainNode | null = null;
  private readonly stems = new Map<StemId, Stem>();

  /** The single timestamp every stem was started at. */
  private startedAt = 0;
  private started = false;
  private loaded: LoadedStems | null = null;
  private lastLevel = 0;
  private lastCutoff = MIN_CUTOFF_HZ;
  private nextGlitchAt = 0;
  /** Advances on the tick clock so `bars` works without audio. */
  private clock = 0;

  get running(): boolean {
    return this.started;
  }

  /** Stems that fell back to silence because their file was missing. */
  get missingStems(): StemId[] {
    return this.loaded?.missing ?? [];
  }

  /** Stems whose file length disagreed with the manifest — these WILL drift. */
  get mismatchedStems(): { id: StemId; seconds: number }[] {
    return this.loaded?.mismatched ?? [];
  }

  /** Bars elapsed. Constant rate at every intensity — tempo never changes. */
  get bars(): number {
    return Math.floor(this.clock / BAR_SECONDS);
  }

  /** Position within the shared loop, 0..1. Identical for every stem. */
  get loopPhase(): number {
    if (!this.ctx || !this.started) return (this.clock % LOOP_SECONDS) / LOOP_SECONDS;
    return ((this.ctx.currentTime - this.startedAt) % LOOP_SECONDS) / LOOP_SECONDS;
  }

  /* ------------------------------------------------------------------ load */

  /**
   * Builds the graph, loads every stem, and starts them all on one timestamp.
   * Safe to call once audio has been unlocked by a user gesture; repeat calls
   * are ignored so the music can never be restarted by accident.
   */
  async attach(ctx: AudioContext | null, out: GainNode | null, base = ""): Promise<void> {
    if (this.ctx || !ctx || !out) return;
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = QUIET_LEVEL;
    this.master.connect(out);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = MIN_CUTOFF_HZ;
    this.filter.Q.value = 0.7;
    this.filter.connect(this.master);

    this.glitch = ctx.createGain();
    this.glitch.gain.value = 1;
    this.glitch.connect(this.filter);

    for (const spec of STEMS) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.glitch);
      this.stems.set(spec.id, {
        id: spec.id,
        gain,
        source: null,
        level: spec.enterAt < 0 ? 1 : 0,
        target: spec.enterAt < 0 ? 1 : 0,
      });
    }

    this.loaded = await loadStems(ctx, base);

    // Everything starts on one timestamp, slightly in the future so the
    // scheduling is sample-accurate rather than "as soon as each is ready".
    const t0 = ctx.currentTime + 0.12;
    for (const spec of STEMS) {
      const stem = this.stems.get(spec.id);
      const buffer = this.loaded.buffers.get(spec.id);
      if (!stem || !buffer) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(stem.gain);
      src.start(t0);
      stem.source = src;
    }
    this.startedAt = t0;
    this.started = true;
  }

  /* ------------------------------------------------------------- notifiers */

  /** Direct control, for scripted moments. Normally driven by `setThreat`. */
  setIntensity(level: number): void {
    this.target = Math.max(0, Math.min(5, level));
  }

  onDetection(): void {
    this.target = Math.max(this.target, 4);
    this.intensity = Math.max(this.intensity, 3.1);
  }

  onLostSight(): void {
    // Deliberately nothing abrupt. A search still has to sound dangerous, and
    // the slow fall rate is what makes the relief false.
  }

  onRetrace(): void {
    this.warp = 1;
  }

  onCatch(): void {
    // A capture jolts the score without collapsing it.
    this.warp = Math.max(this.warp, 0.55);
  }

  onHuntStart(): void {
    this.target = 5;
    this.intensity = Math.max(this.intensity, 4.4);
  }

  onHuntEnd(): void {
    // Let the normal fall rate bring it down; never a cut.
  }

  onCollapse(): void {
    this.collapsed = true;
    this.warp = 1;
  }

  /** Baseline restored: the arrangement rebuilds from ambient upward. */
  onRestore(): void {
    this.collapsed = false;
    this.intensity = 0;
    this.target = 0;
    this.corruption = 0;
  }

  onStoryEvent(): void {
    this.target = Math.max(this.target, 1.5);
  }

  /* ----------------------------------------------------------------- input */

  setThreat(s: ThreatSnapshot): void {
    this.corruption = s.corruption;

    let level: number;
    if (s.hunting) level = 5;
    else if (s.chasing && s.detected) level = 4.4;
    else if (s.detected) level = 4;
    else if (s.distanceTiles < 9) level = 3;
    else if (s.distanceTiles < 18) level = 1.8;
    else level = 0;

    // Below detection, proximity is continuous — walking a corridor swells the
    // arrangement rather than stepping through bands.
    if (level < 4) {
      const near = Math.max(0, Math.min(3.2, (26 - s.distanceTiles) / 6));
      level = Math.max(level, near);
    }
    this.target = level;
  }

  /* ------------------------------------------------------------------ tick */

  update(dt: number, hasLineOfSight = false): void {
    this.clock += dt;

    const rising = this.target > this.intensity;
    if (this.target >= this.intensity) this.releaseHold = RELEASE_HOLD_SECONDS;
    else this.releaseHold = Math.max(0, this.releaseHold - dt);

    const rate = rising
      ? RISE_PER_SECOND + (hasLineOfSight ? SIGHTED_RISE_BONUS : 0)
      : this.releaseHold > 0
        ? 0
        : FALL_PER_SECOND;
    const delta = this.target - this.intensity;
    this.intensity += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);

    this.warp = Math.max(0, this.warp - dt * 1.4);
    if (this.collapsed) this.intensity = 0;

    this.advanceArrangement(dt);

    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    this.applyGains(now);
    this.applyFilter(now);
    this.applyPitch(now);
    this.applyCorruption(now);
  }

  /**
   * Decides which stems belong in the arrangement and eases each toward its
   * target. Runs with or without audio, so `mix()` is meaningful in tests.
   */
  private advanceArrangement(dt: number): void {
    const silence = this.collapsed || this.muted;
    for (const spec of STEMS) {
      const stem = this.stems.get(spec.id) ?? this.ensureStem(spec.id);
      const on = stem.target > 0.5;
      // Hysteresis: harder to leave than to join.
      const wants = on
        ? this.intensity > spec.enterAt - ENTRY_HYSTERESIS
        : this.intensity >= spec.enterAt;
      stem.target = silence ? 0 : wants ? 1 : 0;

      const fade = stem.target > stem.level ? FADE_IN : FADE_OUT;
      const stepSize = dt / fade;
      const gap = stem.target - stem.level;
      stem.level += Math.sign(gap) * Math.min(Math.abs(gap), stepSize);
    }
  }

  /** Backing entry for stems before `attach` — keeps the model testable. */
  private ensureStem(id: StemId): Stem {
    const spec = STEMS.find((s) => s.id === id)!;
    const stem: Stem = {
      id,
      gain: null as unknown as GainNode,
      source: null,
      level: spec.enterAt < 0 ? 1 : 0,
      target: spec.enterAt < 0 ? 1 : 0,
    };
    this.stems.set(id, stem);
    return stem;
  }

  private applyGains(now: number): void {
    if (!this.master) return;
    let active = 0;
    for (const spec of STEMS) {
      const stem = this.stems.get(spec.id);
      if (!stem?.gain) continue;
      if (stem.level > 0.01) active++;
      stem.gain.gain.setTargetAtTime(stem.level * spec.trim, now, 0.08);
    }

    // A fuller arrangement must read as denser, not louder.
    const eased = Math.pow(Math.max(0, Math.min(1, this.intensity / 5)), 0.7);
    const level = QUIET_LEVEL + (LOUD_LEVEL - QUIET_LEVEL) * eased;
    const compensated = level / (1 + 0.06 * Math.max(0, active - 1));
    const target = this.muted || this.collapsed ? 0 : compensated;
    const smooth = target >= this.lastLevel ? SMOOTH.levelUp : SMOOTH.levelDown;
    this.lastLevel = target;
    this.master.gain.setTargetAtTime(target, now, smooth);
  }

  /** Opening the filter makes identical material feel more urgent, for free. */
  private applyFilter(now: number): void {
    if (!this.filter) return;
    const i = Math.max(0, this.intensity);
    const cutoff = MIN_CUTOFF_HZ * Math.pow(2, i * 0.92) * (1 - this.warp * 0.75);
    const hz = Math.max(MIN_CUTOFF_HZ * 0.4, Math.min(16000, cutoff));
    const smooth = hz >= this.lastCutoff ? SMOOTH.filterOpen : SMOOTH.filterClose;
    this.lastCutoff = hz;
    this.filter.frequency.setTargetAtTime(hz, now, smooth);
    this.filter.Q.setTargetAtTime(0.7 + i * 0.28, now, 0.6);
  }

  /**
   * RETRACE pitch-bends the whole score. Every source gets an identical
   * automation curve at an identical time, so they bend together and stay
   * phase-locked — a per-stem rate change would desynchronise them permanently.
   */
  private applyPitch(now: number): void {
    const rate = 1 - this.warp * 0.22;
    for (const stem of this.stems.values()) {
      if (!stem.source) continue;
      stem.source.playbackRate.setTargetAtTime(rate, now, 0.08);
    }
  }

  /** Temporal damage: short digital dropouts punched through the whole bus. */
  private applyCorruption(now: number): void {
    const glitch = this.glitch;
    if (!glitch) return;
    const c = this.corruption;
    if (c <= 0.01 || this.collapsed || now < this.nextGlitchAt) return;

    this.nextGlitchAt = now + 0.25 + Math.random() * (2.2 - c * 1.6);
    const len = 0.03 + Math.random() * 0.09 * c;
    glitch.gain.setValueAtTime(1, now);
    glitch.gain.setValueAtTime(0, now + 0.001);
    glitch.gain.setValueAtTime(0, now + len);
    glitch.gain.setValueAtTime(1, now + len + 0.001);
  }

  /* --------------------------------------------------------------- readout */

  /** Current arrangement, 0..1 per stem. Works without audio. */
  mix(): Record<StemId, number> {
    const out = {} as Record<StemId, number>;
    for (const spec of STEMS) {
      out[spec.id] = this.stems.get(spec.id)?.level ?? (spec.enterAt < 0 ? 1 : 0);
    }
    if (this.collapsed || this.muted) {
      for (const id of STEM_IDS) out[id] = 0;
    }
    return out;
  }

  /** How many parts are audible. The honest measure of "fuller". */
  activeStems(): number {
    const m = this.mix();
    return STEM_IDS.reduce((n, id) => n + (m[id] > 0.01 ? 1 : 0), 0);
  }

  /** Normalised filter openness, 0..1. The build, as a number. */
  brightness(): number {
    return Math.max(0, Math.min(1, this.intensity / 5));
  }
}
