/**
 * The single place the soundtrack is configured.
 *
 * Everything about the score — the composition it assumes, which stems exist,
 * where their files live, and when each one joins the arrangement — is declared
 * here. Replacing the placeholder audio with a real recording is a matter of
 * dropping files into `public/audio/music/` that match COMPOSITION; no code
 * changes anywhere.
 *
 * Pure data: no DOM, no audio APIs, so it is safe to import from tests.
 */

/**
 * The contract every stem must honour. Any replacement audio has to match these
 * exactly or the stems will drift apart.
 *
 * 84 BPM at 44.1 kHz is deliberate: 4 bars comes to exactly 504000 samples, so
 * the loop point lands on a sample boundary with no rounding.
 */
export const COMPOSITION = {
  bpm: 84,
  beatsPerBar: 4,
  /** Bars per loop. Every stem file must be exactly this long. */
  bars: 4,
  key: "A minor",
  /** Chord roots per bar, for anyone writing replacement stems. */
  progression: ["Am", "F", "Dm", "E"],
  sampleRate: 44100,
} as const;

export const SECONDS_PER_BEAT = 60 / COMPOSITION.bpm;
export const BAR_SECONDS = SECONDS_PER_BEAT * COMPOSITION.beatsPerBar;
/** Exact loop length every stem shares. */
export const LOOP_SECONDS = BAR_SECONDS * COMPOSITION.bars;

export type StemId =
  | "ambient"
  | "bass"
  | "percussion"
  | "tension"
  | "mimic"
  | "chase"
  | "hunt";

export interface StemSpec {
  id: StemId;
  /** File under `public/audio/music/`. Drop a replacement here to override. */
  file: string;
  /**
   * Intensity at which this stem joins the arrangement. Below it the stem is
   * silent but still playing, so it never has to be restarted.
   */
  enterAt: number;
  /** Mix trim, so a full arrangement stays balanced. */
  trim: number;
  /** What the stem is, for whoever writes the replacement. */
  role: string;
}

/**
 * The arrangement ladder. This is the table that defines the intensity levels
 * described in the design: 0 ambient, 1 +bass, 2 +percussion, 3 +tension+motif,
 * 4 chase, 5 hunt.
 */
export const STEMS: readonly StemSpec[] = [
  {
    id: "ambient",
    file: "ambient.wav",
    enterAt: -1,
    trim: 0.55,
    role: "Room tone and sustained pad. Always audible.",
  },
  {
    id: "bass",
    file: "bass.wav",
    enterAt: 1,
    trim: 0.5,
    role: "Sub-bass root movement.",
  },
  {
    id: "percussion",
    file: "percussion.wav",
    enterAt: 2,
    trim: 0.45,
    role: "Light kit — pulse and hats.",
  },
  {
    id: "tension",
    file: "tension.wav",
    enterAt: 3,
    trim: 0.4,
    role: "Arpeggiated tension synth.",
  },
  {
    id: "mimic",
    file: "mimic.wav",
    enterAt: 3,
    trim: 0.5,
    role: "MIMIC's motif. Sparse and recognisable.",
  },
  {
    id: "chase",
    file: "chase.wav",
    enterAt: 4,
    trim: 0.5,
    role: "Full chase kit and aggressive bass.",
  },
  {
    id: "hunt",
    file: "hunt.wav",
    enterAt: 5,
    trim: 0.5,
    role: "Facility emergency layer. Hunt Mode only.",
  },
];

export const STEM_IDS: readonly StemId[] = STEMS.map((s) => s.id);

/** Where the loader looks. Served straight out of `public/`. */
export const MUSIC_DIR = "audio/music";

export const stemUrl = (spec: StemSpec): string => `${MUSIC_DIR}/${spec.file}`;
