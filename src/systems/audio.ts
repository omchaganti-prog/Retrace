/**
 * Synthesised SFX. No asset files: every sound is a short oscillator or noise
 * burst, which keeps the repo asset-free and matches the generated pixel art.
 *
 * Volume is driven by the same residual loudness MIMIC hears, so what you hear
 * and what it hears agree — an ECHO sprinting two rooms away is faint to both.
 *
 * Three things keep it from sounding like a test tone:
 *
 *  - Voices are layered. A dash is an air-tear *and* a low thump; a door is a
 *    servo *and* the clunk of the bolt. One oscillator per event is what makes
 *    procedural audio sound cheap.
 *  - Every play is detuned and re-timed slightly, so a run of footsteps is a
 *    walk rather than a machine gun.
 *  - Occluded sounds are low-passed, not merely quieted. A noise through a wall
 *    loses its top end first, which is the cue that tells you it is behind
 *    something rather than simply far away.
 */
import type { SoundKind } from "./sound";

interface Layer {
  /** Oscillator type, or "noise" for a filtered burst. */
  wave: OscillatorType | "noise";
  freq: number;
  /** Frequency at the end of the envelope. */
  endFreq: number;
  duration: number;
  gain: number;
  /** Resonance for the noise band-pass. Higher is more tonal, more "ping". */
  q?: number;
  /** Seconds to wait before this layer starts, for a two-part hit. */
  delay?: number;
}

interface Voice {
  layers: Layer[];
  /** Fraction of pitch wobble applied per play, 0 for pitch-critical cues. */
  jitter?: number;
}

/** One-layer voice, the common case. */
const one = (l: Layer, jitter = 0.05): Voice => ({ layers: [l], jitter });

const VOICES: Record<SoundKind, Voice> = {
  // Footsteps get a soft body under the scuff, and the most jitter of anything —
  // identical consecutive steps are the single biggest tell of fake audio.
  step: {
    jitter: 0.16,
    layers: [
      { wave: "noise", freq: 620, endFreq: 240, duration: 0.07, gain: 0.15, q: 1.1 },
      { wave: "sine", freq: 150, endFreq: 70, duration: 0.06, gain: 0.07 },
    ],
  },
  sprint: {
    jitter: 0.16,
    layers: [
      { wave: "noise", freq: 900, endFreq: 260, duration: 0.09, gain: 0.27, q: 1.1 },
      { wave: "sine", freq: 190, endFreq: 80, duration: 0.08, gain: 0.12 },
    ],
  },
  /** Cloth and a careful sole. Almost no transient, so it never cuts through. */
  sneak: {
    jitter: 0.2,
    layers: [
      { wave: "noise", freq: 380, endFreq: 170, duration: 0.09, gain: 0.05, q: 0.7 },
      { wave: "sine", freq: 110, endFreq: 60, duration: 0.07, gain: 0.03 },
    ],
  },
  interact: {
    jitter: 0.02,
    layers: [
      { wave: "square", freq: 660, endFreq: 990, duration: 0.09, gain: 0.1 },
      { wave: "sine", freq: 1320, endFreq: 1980, duration: 0.07, gain: 0.04 },
    ],
  },
  // Servo travel, then the bolt landing.
  door: {
    jitter: 0.04,
    layers: [
      { wave: "sawtooth", freq: 180, endFreq: 90, duration: 0.34, gain: 0.12 },
      { wave: "noise", freq: 420, endFreq: 160, duration: 0.3, gain: 0.06, q: 0.8 },
      { wave: "square", freq: 120, endFreq: 60, duration: 0.1, gain: 0.09, delay: 0.26 },
    ],
  },
  // The temporal link folding: a bright tone falling away under a rising shimmer.
  retrace: {
    jitter: 0,
    layers: [
      { wave: "sine", freq: 880, endFreq: 110, duration: 0.55, gain: 0.2 },
      { wave: "triangle", freq: 1760, endFreq: 220, duration: 0.4, gain: 0.06 },
      { wave: "noise", freq: 300, endFreq: 2200, duration: 0.5, gain: 0.05, q: 2.4 },
    ],
  },
  alarm: {
    jitter: 0.01,
    layers: [
      { wave: "square", freq: 440, endFreq: 620, duration: 0.5, gain: 0.13 },
      { wave: "sawtooth", freq: 221, endFreq: 310, duration: 0.5, gain: 0.06 },
    ],
  },
  // The capture. Wants weight, so most of it is below 150 Hz.
  impact: {
    jitter: 0.03,
    layers: [
      { wave: "sawtooth", freq: 140, endFreq: 40, duration: 0.4, gain: 0.26 },
      { wave: "sine", freq: 70, endFreq: 28, duration: 0.55, gain: 0.22 },
      { wave: "noise", freq: 900, endFreq: 120, duration: 0.18, gain: 0.12, q: 0.7 },
    ],
  },
  // Dead, downward electronic buzz — a link failing rather than an alarm.
  jam: {
    jitter: 0.06,
    layers: [
      { wave: "square", freq: 300, endFreq: 70, duration: 0.22, gain: 0.15 },
      { wave: "sawtooth", freq: 151, endFreq: 36, duration: 0.26, gain: 0.09 },
    ],
  },
  /** Sharp air-tear on the burst, with a thump so it lands in the body. */
  dash: {
    jitter: 0.08,
    layers: [
      { wave: "noise", freq: 1800, endFreq: 400, duration: 0.16, gain: 0.22, q: 1.6 },
      { wave: "sine", freq: 220, endFreq: 60, duration: 0.2, gain: 0.16 },
    ],
  },
  /**
   * MIMIC's footfall. Deliberately unlike the player's: no scuff, no body —
   * a servo click and a low mechanical thud. Through a wall the occlusion
   * filter leaves only the thud, which is exactly the cue you want.
   */
  mimicStep: {
    jitter: 0.05,
    layers: [
      { wave: "square", freq: 1400, endFreq: 900, duration: 0.035, gain: 0.07, q: 2.2 },
      { wave: "sine", freq: 96, endFreq: 44, duration: 0.14, gain: 0.2 },
      { wave: "noise", freq: 320, endFreq: 140, duration: 0.06, gain: 0.05, q: 1.4, delay: 0.02 },
    ],
  },
  /** Rising wind-up, played in ticks while charging. Pitch carries the charge. */
  charge: one({ wave: "sine", freq: 300, endFreq: 700, duration: 0.09, gain: 0.06 }, 0),
  /** Dry click when there is not enough left. */
  drained: {
    jitter: 0.03,
    layers: [
      { wave: "square", freq: 180, endFreq: 90, duration: 0.09, gain: 0.1 },
      { wave: "noise", freq: 260, endFreq: 120, duration: 0.06, gain: 0.05, q: 0.9 },
    ],
  },
  // Ability tells. Each is distinct enough to learn, short enough not to nag.
  /** Rising scanner tone. */
  scan: {
    jitter: 0.01,
    layers: [
      { wave: "sine", freq: 420, endFreq: 1150, duration: 0.5, gain: 0.09 },
      { wave: "sine", freq: 840, endFreq: 2300, duration: 0.5, gain: 0.03 },
    ],
  },
  /** Hard electronic bolt throw. */
  lock: {
    jitter: 0.03,
    layers: [
      { wave: "square", freq: 220, endFreq: 130, duration: 0.16, gain: 0.17 },
      { wave: "noise", freq: 1400, endFreq: 500, duration: 0.05, gain: 0.09, q: 1.4 },
    ],
  },
  /** Short digital connection chirp. */
  link: one({ wave: "triangle", freq: 900, endFreq: 1500, duration: 0.08, gain: 0.1 }, 0.03),
  /** Electrical discharge. */
  surge: {
    jitter: 0.07,
    layers: [
      { wave: "sawtooth", freq: 520, endFreq: 60, duration: 0.42, gain: 0.13 },
      { wave: "noise", freq: 2400, endFreq: 300, duration: 0.3, gain: 0.08, q: 0.9 },
    ],
  },
  /** Low system-activation tone. */
  override: {
    jitter: 0.01,
    layers: [
      { wave: "sawtooth", freq: 90, endFreq: 220, duration: 0.9, gain: 0.13 },
      { wave: "sine", freq: 45, endFreq: 110, duration: 0.9, gain: 0.1 },
    ],
  },
};

/** Cutoff a fully occluded sound is dragged down to. */
const OCCLUDED_HZ = 520;
const OPEN_HZ = 18_000;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  /** Per-play variation. Presentation only, so it never touches the sim's Rng. */
  private seed = 0x9e3779b9;

  /** Must be called from a user gesture — browsers block audio before one. */
  resume(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();

      // Everything lands on a limiter. Without it, a door, an alarm and three
      // footsteps on the same tick clip the output and the whole mix crackles.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;
      limiter.connect(this.ctx.destination);

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(limiter);
      // Music rides its own bus so it can be ducked and muted independently of
      // the gameplay cues, and so both share one AudioContext.
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.85;
      this.musicBus.connect(limiter);
      this.noise = this.buildNoise(this.ctx);
    }
    void this.ctx.resume();
  }

  /** The shared context, once a user gesture has unlocked it. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Destination for the music layers. */
  get musicOut(): GainNode | null {
    return this.musicBus;
  }

  /** Shared noise buffer, so the music layers do not rebuild their own. */
  get noiseBuffer(): AudioBuffer | null {
    return this.noise;
  }

  private buildNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let s = 0x2f6e2b1;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      data[i] = (s / 0xffffffff) * 2 - 1;
    }
    return buf;
  }

  /** -1..1 */
  private wobble(): number {
    this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (this.seed / 0xffffffff) * 2 - 1;
  }

  /**
   * `volume` is 0..1 (already distance-attenuated); `pan` is -1..1 relative to
   * the listener; `occlusion` is 0..1 for how much geometry the sound came
   * through, which rolls off its top end.
   */
  play(kind: SoundKind, volume: number, pan = 0, occlusion = 0): void {
    if (this.muted || volume <= 0.01) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== "running") return;

    const voice = VOICES[kind];
    const now = ctx.currentTime;

    // One detune and one time-stretch shared by every layer, so a voice stays
    // internally coherent while differing from the last time it played.
    const jitter = voice.jitter ?? 0.05;
    const detune = 1 + this.wobble() * jitter;
    const stretch = 1 + this.wobble() * jitter * 0.5;

    // Shared tail: occlusion low-pass, then panning, then the master bus.
    const cutoff = OCCLUDED_HZ + (OPEN_HZ - OCCLUDED_HZ) * (1 - Math.min(1, occlusion)) ** 2;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = Math.max(200, cutoff);
    tone.Q.value = 0.7;

    const panner = ctx.createStereoPanner?.();
    if (panner) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      tone.connect(panner).connect(master);
    } else {
      tone.connect(master);
    }

    for (const layer of voice.layers) {
      const start = now + (layer.delay ?? 0) * stretch;
      const dur = Math.max(0.02, layer.duration * stretch);
      const f0 = Math.max(20, layer.freq * detune);
      const f1 = Math.max(20, layer.endFreq * detune);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, layer.gain * volume), start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      gain.connect(tone);

      if (layer.wave === "noise") {
        if (!this.noise) continue;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        // Read the shared buffer from a different place each time, so repeated
        // bursts are genuinely different noise instead of the same 0.4s clip.
        const offset = Math.abs(this.wobble()) * Math.max(0, this.noise.duration - dur);
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(f0, start);
        filter.frequency.exponentialRampToValueAtTime(f1, start + dur);
        filter.Q.value = layer.q ?? 1.2;
        src.connect(filter).connect(gain);
        src.start(start, offset);
        src.stop(start + dur);
      } else {
        const osc = ctx.createOscillator();
        osc.type = layer.wave;
        osc.frequency.setValueAtTime(f0, start);
        osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
        osc.connect(gain);
        osc.start(start);
        osc.stop(start + dur);
      }
    }
  }
}
