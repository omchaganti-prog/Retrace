/**
 * Renders the placeholder music stems.
 *
 *   node tools/make-placeholder-music.mjs
 *
 * Writes seven perfectly-looping mono WAVs into public/audio/music/. They are
 * intentionally plain — the point is the framework, not the tune. Replace any
 * file with real audio of the same length and the game picks it up with no code
 * changes.
 *
 * Contract (must match src/systems/music/manifest.ts):
 *   84 BPM · 4/4 · 4 bars · A minor · Am–F–Dm–E · 44100 Hz
 *   = exactly 504000 samples, so the loop point is sample-exact.
 */
import fs from "node:fs";
import path from "node:path";

const BPM = 84;
const BEATS_PER_BAR = 4;
const BARS = 4;
const SR = 44100;
const SECONDS_PER_BEAT = 60 / BPM;
const BAR_SECONDS = SECONDS_PER_BEAT * BEATS_PER_BAR;
const LOOP_SECONDS = BAR_SECONDS * BARS;
const N = Math.round(LOOP_SECONDS * SR);
const STEP = SECONDS_PER_BEAT / 4; // sixteenth
const OUT = path.resolve("public/audio/music");

/** Am – F – Dm – E, one chord per bar. */
const PROGRESSION = [
  { bass: 55.0, tones: [220.0, 261.63, 329.63] },
  { bass: 43.65, tones: [174.61, 220.0, 261.63] },
  { bass: 36.71, tones: [146.83, 174.61, 220.0] },
  { bass: 41.2, tones: [164.81, 207.65, 246.94] },
];

/** MIMIC's signature: a fall through a tritone. */
const MOTIF = [
  { step: 0, freq: 220.0, dur: 0.5 },
  { step: 3, freq: 155.56, dur: 0.4 },
  { step: 6, freq: 174.61, dur: 0.4 },
  { step: 10, freq: 110.0, dur: 0.9 },
];

const wave = (type, phase) => {
  const t = phase % 1;
  switch (type) {
    case "sine":
      return Math.sin(phase * Math.PI * 2);
    case "saw":
      return 2 * t - 1;
    case "square":
      return t < 0.5 ? 1 : -1;
    case "tri":
      return 4 * Math.abs(t - 0.5) - 1;
    default:
      return 0;
  }
};

/** Deterministic noise, so regenerating gives identical files. */
let seed = 0x2f6e2b1;
const noise = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
  return (seed / 0xffffffff) * 2 - 1;
};

/**
 * Adds a note, wrapping past the loop end back to the start so a tail that
 * crosses the boundary still lines up seamlessly.
 */
function addNote(buf, startSec, durSec, freq, type, level, attack = 0.005) {
  const start = Math.round(startSec * SR);
  const len = Math.round(durSec * SR);
  const atk = Math.max(1, Math.round(attack * SR));
  for (let i = 0; i < len; i++) {
    const env =
      i < atk ? i / atk : Math.pow(1 - (i - atk) / Math.max(1, len - atk), 2.2);
    const phase = (freq * i) / SR;
    buf[(start + i) % N] += wave(type, phase) * env * level;
  }
}

function addNoise(buf, startSec, durSec, level, decay = 2.5) {
  const start = Math.round(startSec * SR);
  const len = Math.round(durSec * SR);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, decay);
    buf[(start + i) % N] += noise() * env * level;
  }
}

/** Sub-bass drop, for kicks. */
function addKick(buf, startSec, level) {
  const len = Math.round(0.26 * SR);
  const start = Math.round(startSec * SR);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const k = i / len;
    const freq = 150 * Math.pow(0.28, k);
    phase += freq / SR;
    buf[(start + i) % N] += Math.sin(phase * Math.PI * 2) * Math.pow(1 - k, 2.4) * level;
  }
}

const barOf = (bar) => PROGRESSION[bar % PROGRESSION.length];
const stepTime = (bar, step) => bar * BAR_SECONDS + step * STEP;

/* ------------------------------------------------------------------ stems */

const render = {
  ambient(buf) {
    // Sustained pad per bar, slightly overlapping, plus a filtered air bed.
    for (let bar = 0; bar < BARS; bar++) {
      const c = barOf(bar);
      for (const tone of c.tones) {
        addNote(buf, bar * BAR_SECONDS, BAR_SECONDS * 1.05, tone, "saw", 0.06, 0.6);
        addNote(buf, bar * BAR_SECONDS, BAR_SECONDS * 1.05, tone * 1.005, "saw", 0.05, 0.6);
      }
      addNote(buf, bar * BAR_SECONDS, BAR_SECONDS * 1.05, c.bass, "sine", 0.18, 0.5);
    }
    // Low rumble bed. One-pole lowpass over noise.
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp += (noise() - lp) * 0.004;
      buf[i] += lp * 0.5;
    }
  },

  bass(buf) {
    for (let bar = 0; bar < BARS; bar++) {
      const c = barOf(bar);
      for (const s of [0, 6, 8, 14]) {
        addNote(buf, stepTime(bar, s), STEP * 1.8, c.bass * 2, "tri", 0.42);
      }
    }
  },

  percussion(buf) {
    for (let bar = 0; bar < BARS; bar++) {
      for (const s of [0, 8]) addKick(buf, stepTime(bar, s), 0.5);
      for (const s of [2, 6, 10, 14]) addNoise(buf, stepTime(bar, s), 0.035, 0.12, 4);
    }
  },

  tension(buf) {
    // Eighth-note arpeggio across the chord.
    for (let bar = 0; bar < BARS; bar++) {
      const c = barOf(bar);
      for (let s = 0; s < 16; s += 2) {
        const tone = c.tones[(s / 2) % c.tones.length] * 2;
        addNote(buf, stepTime(bar, s), STEP * 1.4, tone, "tri", 0.14);
      }
    }
  },

  mimic(buf) {
    // Twice per loop, so it stays a signature rather than wallpaper.
    for (const bar of [0, 2]) {
      for (const n of MOTIF) {
        addNote(buf, stepTime(bar, n.step), n.dur, n.freq, "square", 0.16, 0.01);
        addNote(buf, stepTime(bar, n.step), n.dur, n.freq * 1.008, "square", 0.12, 0.01);
      }
    }
  },

  chase(buf) {
    for (let bar = 0; bar < BARS; bar++) {
      const c = barOf(bar);
      for (const s of [0, 4, 8, 12]) addKick(buf, stepTime(bar, s), 0.55);
      for (const s of [4, 12]) addNoise(buf, stepTime(bar, s), 0.13, 0.2, 2);
      for (let s = 0; s < 16; s += 2) {
        addNoise(buf, stepTime(bar, s), 0.03, 0.07, 5);
        addNote(buf, stepTime(bar, s), STEP * 1.2, c.bass * 2, "saw", 0.16);
      }
    }
  },

  hunt(buf) {
    // Siren sweep across the whole loop, doubled kick, alarm stabs.
    let phase = 0;
    for (let i = 0; i < N; i++) {
      const k = i / N;
      const freq = 300 + Math.sin(k * Math.PI * 2 * 2) * 90;
      phase += freq / SR;
      buf[i] += wave("saw", phase) * 0.05;
    }
    for (let bar = 0; bar < BARS; bar++) {
      for (let s = 0; s < 16; s += 2) addKick(buf, stepTime(bar, s), 0.4);
      for (const s of [6, 14]) addNoise(buf, stepTime(bar, s), 0.09, 0.16, 3);
      addNote(buf, stepTime(bar, 0), BAR_SECONDS * 0.5, 110, "square", 0.1, 0.05);
    }
  },
};

/* ------------------------------------------------------------------- wav */

function writeWav(file, samples) {
  const bytes = samples.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`${BPM} BPM · ${BARS} bars · ${LOOP_SECONDS.toFixed(6)}s · ${N} samples`);

for (const [id, fn] of Object.entries(render)) {
  seed = 0x2f6e2b1; // reset so every run is byte-identical
  const buf = new Float32Array(N);
  fn(buf);

  // Normalise to a consistent headroom rather than clipping.
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const gain = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < N; i++) buf[i] *= gain;

  const file = path.join(OUT, `${id}.wav`);
  writeWav(file, buf);
  console.log(`  ${id.padEnd(11)} peak ${peak.toFixed(3)} -> ${file}`);
}
console.log("done");
