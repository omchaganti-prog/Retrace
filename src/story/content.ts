/**
 * All of RETRACE's story text, in one editable file.
 *
 * Nothing here is code. Terminal pages, announcements, MIMIC's lines, the
 * opening and the ending are data, so the writing can be rewritten without
 * touching a system. The rule the whole script obeys: state the fact, never the
 * implication. The facility does not editorialise, and neither does MIMIC.
 *
 * The number that matters — BASELINE RESTORATIONS — is simply printed and left
 * alone. No character explains it. That is the entire design.
 */
import type { StoryFlag } from "./flags";

/* ------------------------------------------------------------------ opening */

/**
 * The boot sequence. Timings are in seconds from the start; the whole thing runs
 * about eleven seconds and can be skipped once it has been seen.
 */
export interface OpeningLine {
  at: number;
  text: string;
  /** Renders in the corrupted style and shakes the frame. */
  glitch?: boolean;
  /** Bigger, for the two title beats. */
  large?: boolean;
}

export const OPENING: OpeningLine[] = [
  { at: 0.8, text: "AXIOM SYSTEMS", large: true },
  { at: 2.2, text: "INITIALIZING..." },
  { at: 3.6, text: "PROJECT RETRACE" },
  { at: 4.8, text: "SUBJECT: 047" },
  { at: 5.8, text: "TRIAL: 047" },
  { at: 7.0, text: "MEMORY STATUS:" },
  { at: 7.9, text: "..." },
  // The first crack. Half a second, no explanation, never mentioned again.
  { at: 8.6, text: "ERROR", glitch: true },
  { at: 9.9, text: "BEGIN.", large: true },
];

export const OPENING_SECONDS = 11.2;

/* ------------------------------------------------------------- announcements */

export interface AnnouncementDef {
  id: string;
  text: string;
  /** Seconds on screen. */
  seconds?: number;
  tone?: "system" | "warn" | "corrupt";
}

export const ANNOUNCEMENTS: Record<string, AnnouncementDef> = {
  welcome: { id: "welcome", text: "SUBJECT 047 — PROCEED TO TESTING.", seconds: 4 },
  temporalDetected: { id: "temporalDetected", text: "TEMPORAL EVENT DETECTED.", seconds: 3 },
  replicationRequired: {
    id: "replicationRequired",
    text: "TEMPORAL REPLICATION REQUIRED.",
    seconds: 4,
  },
  observing: { id: "observing", text: "MONITORING CORE ACTIVE.", seconds: 3 },
  anomaly: { id: "anomaly", text: "TEMPORAL ANOMALY — SECTOR UNSTABLE.", seconds: 3.5, tone: "warn" },
  containmentFailure: {
    id: "containmentFailure",
    text: "CONTAINMENT FAILURE. SURFACE ACCESS LOCKED.",
    seconds: 4.5,
    tone: "warn",
  },
  surfaceUnlocked: {
    id: "surfaceUnlocked",
    text: "SURFACE ACCESS — SEAL RELEASED.",
    seconds: 4,
    tone: "warn",
  },
  restoring: { id: "restoring", text: "RESTORING SUBJECT 047...", seconds: 3, tone: "corrupt" },
};

/* --------------------------------------------------------------- MIMIC lines */

/**
 * What MIMIC says, in the order it earns the right to say it.
 *
 * Each line fires once, and only when the game state genuinely justifies it —
 * "YOU ALWAYS USE THIS ROUTE" is gated on the route counter actually being
 * lopsided. A line it has not earned is a line that reads as writing.
 */
export interface MimicLineDef {
  id: string;
  text: string;
  /** Story flag raised when it fires, so it never repeats. */
  flag: StoryFlag | null;
  /** Minimum knowledge (0..100) before this line is available. */
  minKnowledge: number;
}

export const MIMIC_LINES: MimicLineDef[] = [
  { id: "detected", text: "SUBJECT DETECTED.", flag: null, minKnowledge: 0 },
  { id: "recorded", text: "BEHAVIOR RECORDED.", flag: null, minKnowledge: 6 },
  { id: "pattern", text: "PATTERN RECOGNIZED.", flag: null, minKnowledge: 18 },
  { id: "route", text: "ROUTE PREDICTED.", flag: null, minKnowledge: 32 },
  { id: "before", text: "YOU HAVE USED THIS ROUTE BEFORE.", flag: null, minKnowledge: 48 },
  { id: "always", text: "YOU ALWAYS RETURN HERE.", flag: null, minKnowledge: 64 },
  // The one the whole game is walking toward.
  { id: "remember", text: "I REMEMBER YOU.", flag: "mimicPurposeRevealed", minKnowledge: 82 },
];

/* ------------------------------------------------------------------ terminals */

export interface TerminalPage {
  /** Heading, printed in cyan. */
  title: string;
  /** Body lines. An empty string is a blank line. */
  lines: string[];
  /**
   * Names a runtime generator instead of static text. The behaviour dossier and
   * the restoration count are both built from real save data at read time.
   */
  generated?: "behaviour" | "trials" | "restorations";
}

export interface TerminalDef {
  id: string;
  /** Prop id this terminal is attached to. */
  propId: string;
  pages: TerminalPage[];
  /** Raised the first time it is read. */
  flag?: StoryFlag;
  /** Plays the trial-number corruption two seconds in. */
  trialGlitch?: boolean;
}

export const TERMINALS: TerminalDef[] = [
  {
    id: "mimic_dossier",
    propId: "term_mimic",
    flag: "firstMimicSighting",
    pages: [
      {
        title: "M.I.M.I.C.",
        lines: [
          "MACHINE INTELLIGENCE",
          "MONITORING & INTERCEPTION CORE",
          "",
          "ROLE:      OBSERVE / LEARN",
          "           PREDICT / CONTAIN",
          "",
          "STATUS:    OBSERVING",
        ],
      },
    ],
  },
  {
    id: "trial_history",
    propId: "term_trials",
    flag: "trialGlitchSeen",
    trialGlitch: true,
    pages: [{ title: "AXIOM RESEARCH FACILITY", lines: [], generated: "trials" }],
  },
  {
    id: "behaviour_profile",
    propId: "term_behaviour",
    flag: "behaviourProfileRead",
    pages: [{ title: "SUBJECT 047 — BEHAVIOR ANALYSIS", lines: [], generated: "behaviour" }],
  },
  {
    id: "archives_restorations",
    propId: "term_archive",
    flag: "restorationCountRead",
    pages: [{ title: "PROJECT RETRACE", lines: [], generated: "restorations" }],
  },
  {
    id: "archives_memory",
    propId: "term_memory",
    flag: "memoryResetRevealed",
    pages: [
      {
        title: "MEMORY SUPPRESSION",
        lines: [
          "SUBJECT:            047",
          "",
          "RESTORATION:        COMPLETE",
          "MEMORY RESTORATION: FAILED",
          "MEMORY SUPPRESSION: SUCCESSFUL",
          "",
          // The line that reframes the entire game, stated as a log field.
          "MIMIC MEMORY:       PRESERVED",
        ],
      },
    ],
  },
  {
    id: "archives_purpose",
    propId: "term_purpose",
    flag: "mimicPurposeRevealed",
    pages: [
      {
        title: "PROJECT RETRACE — CHARTER",
        lines: [
          "PRIMARY OBJECTIVE:",
          "  TEMPORAL BEHAVIOR REPLICATION",
          "",
          "SECONDARY OBJECTIVE:",
          "  ADAPTIVE PREDICTION",
          "",
          "TRAINING SUBJECT:   047",
          "PREDICTION SYSTEM:  MIMIC",
          "",
          "NOTE: PREDICTION ACCURACY SCALES",
          "      WITH SUBJECT TRIAL COUNT.",
        ],
      },
    ],
  },
  {
    id: "containment_truth",
    propId: "term_containment",
    flag: "containmentTruthRevealed",
    pages: [
      {
        title: "SURFACE ACCESS — STANDING ORDER",
        lines: [
          "SUBJECT 047",
          "",
          "EGRESS AUTHORIZATION:  DENIED",
          "REVIEW:                NOT SCHEDULED",
          "",
          "STANDING ORDER:",
          "  SUBJECT 047 IS NOT TO REACH",
          "  SURFACE ACCESS UNDER ANY",
          "  TRIAL OUTCOME.",
          "",
          "ENFORCEMENT:           MIMIC",
        ],
      },
    ],
  },
];

/* ---------------------------------------------------------------- the ending */

export const ENDING: OpeningLine[] = [
  { at: 1.0, text: "SUBJECT 047" },
  { at: 2.0, text: "STATUS: RELEASED" },
  { at: 4.0, text: "PROJECT RETRACE" },
  { at: 5.0, text: "TERMINATED" },
  { at: 7.5, text: "MIMIC LEARNING:  99.9%" },
  { at: 9.4, text: "MIMIC LEARNING: 100%", glitch: true },
  { at: 11.6, text: "RETRACE", large: true },
  { at: 13.0, text: "THE PAST CAN BE LEARNED." },
  { at: 14.2, text: "THE FUTURE CAN'T." },
];

export const ENDING_SECONDS = 17;
