/**
 * WING-01's puzzle content.
 *
 * Kept apart from the level geometry so the rooms and the machines that fill
 * them can be edited independently, and so the whole puzzle progression can be
 * read in one place.
 *
 * The progression is deliberate, and each tier is only solvable by the tier's
 * idea:
 *
 *   1  TEMPORAL DOOR      a switch must be held while you are elsewhere
 *   2  DUAL AUTHENTICATION two switches, one window, one body
 *   3  POWER RELAY         three stages, staggered — needs two ECHOs and you
 *   4  FOUR SIGNATURES     three ECHOs and you, standing in four places at once
 *   5  SOUND CHAMBER       ECHOs reproduce noise, not just motion
 *   6  CAMERA BAIT         a false contact is a resource
 *   7  MIMIC SCANNER       the only containment signature in the wing is MIMIC's
 *   8  DOOR OVERRIDE BAIT  make it spend a counter-measure on a lie
 *   9  THE ORCHESTRA       all of it, at once
 *
 * The test every one of these had to pass: could it exist without RETRACE? If a
 * lone player standing in one place at one time could solve it, it is not a
 * RETRACE puzzle and it is not in this file.
 */
import { type Rect, r } from "./level";
import type { PuzzleDef } from "../puzzle/system";

/** Room bounds, also used for the "you are here" briefs. */
export const ROOMS = {
  generator: r(10, 18, 17, 24),
  security: r(10, 27, 17, 33),
  lab: r(43, 3, 62, 12),
} satisfies Record<string, Rect>;

export const WING01_PUZZLES: PuzzleDef[] = [
  /* ------------------------------------------------------ 1. TEMPORAL DOOR */
  {
    id: "temporal_door",
    label: "GENERATOR INTAKE",
    bounds: r(10, 18, 17, 21),
    brief: "INTAKE CLAMP MUST BE HELD FROM INSIDE",
    components: [
      // The clamp is a scanner pad, not a plate, so the readout can say plainly
      // how many bodies it can feel — which is the lesson of the whole tier.
      //
      // Deliberately at the far end of the chamber from the hatch it holds. Put
      // it any closer and a charged dash off the pad beats the hatch closing,
      // which would let one body solve it and teach the player nothing.
      {
        kind: "scanner",
        id: "gen_clamp",
        emits: "gen.clamp",
        label: "INTAKE CLAMP",
        area: r(15, 19, 16, 20),
      },
    ],
  },

  /* ------------------------------------------------- 2. DUAL AUTHENTICATION */
  {
    id: "dual_auth",
    label: "GENERATOR AUTHORIZATION",
    bounds: r(10, 21, 17, 24),
    brief: "TWO KEYS, ONE WINDOW",
    components: [
      {
        kind: "timed",
        id: "auth_a",
        emits: "auth.a",
        label: "KEY ALPHA",
        propId: "gen_key_a",
        // Generous on purpose. This teaches timing; it does not test reflexes.
        seconds: 9,
      },
      {
        kind: "timed",
        id: "auth_b",
        emits: "auth.b",
        label: "KEY BETA",
        propId: "gen_key_b",
        seconds: 9,
      },
      {
        kind: "latch",
        id: "auth_done",
        emits: "auth.ok",
        label: "AUTHORIZATION",
        when: { all: ["auth.a", "auth.b"] },
        announce: "DUAL AUTHORIZATION ACCEPTED",
        // Stage one of the campaign. One ECHO on the clamp is the whole lesson.
        completes: "intake",
      },
    ],
  },

  /* ------------------------------------------------------- 3. POWER RELAY */
  {
    id: "power_relay",
    label: "RELAY CASCADE",
    bounds: r(10, 22, 17, 24),
    brief: "BOTH BUS CLAMPS LOADED WHEN THE BREAKER FIRES",
    components: [
      // A and B are load pads, not buttons.
      //
      // They were buttons, and that made the cascade solvable alone: a lone
      // player could touch A, walk to B, walk to C and satisfy an ordered
      // sequence, because ordering only asks that each stage go high at *some*
      // point. Weight has to be on both buses at the instant the breaker throws,
      // which no single body can arrange.
      {
        kind: "scanner",
        id: "relay_a",
        emits: "relay.a",
        label: "BUS CLAMP A",
        area: r(10, 23, 11, 24),
      },
      {
        kind: "scanner",
        id: "relay_b",
        emits: "relay.b",
        label: "BUS CLAMP B",
        area: r(13, 23, 14, 24),
      },
      {
        kind: "timed",
        id: "relay_c",
        emits: "relay.c",
        label: "BREAKER",
        propId: "gen_relay_c",
        seconds: 14,
      },
      {
        kind: "latch",
        id: "relay_done",
        emits: "relay.ok",
        label: "CASCADE",
        when: { all: ["relay.a", "relay.b", "relay.c"] },
        announce: "GENERATOR CASCADE ONLINE",
        // Stage three. Two clamps loaded while you throw the breaker.
        completes: "cascade",
      },
    ],
  },

  /* ------------------------------------------------------ 5. SOUND CHAMBER */
  {
    id: "sound_chamber",
    label: "ACOUSTIC BAFFLE",
    bounds: r(10, 27, 17, 33),
    brief: "THREE MICROPHONES, ONE WINDOW",
    components: [
      // Long holds: an ECHO's noise happened when it happened, and the player
      // needs room to get across the room afterwards.
      { kind: "sound", id: "mic_a", emits: "mic.a", label: "MIC A", tx: 11, ty: 28, threshold: 1.1, holdSeconds: 8 },
      { kind: "sound", id: "mic_b", emits: "mic.b", label: "MIC B", tx: 16, ty: 28, threshold: 1.1, holdSeconds: 8 },
      // The third only answers to a dash — the loudest thing you can make on
      // purpose, and the one an ECHO reproduces exactly.
      {
        kind: "sound",
        id: "mic_c",
        emits: "mic.c",
        label: "MIC C (IMPULSE)",
        tx: 13,
        ty: 32,
        threshold: 1.1,
        holdSeconds: 8,
        accepts: ["dash", "sprint"],
      },
      {
        kind: "latch",
        id: "mic_done",
        emits: "mic.ok",
        label: "BAFFLE",
        when: { all: ["mic.a", "mic.b", "mic.c"] },
        announce: "ACOUSTIC LOCK RESOLVED",
      },
    ],
  },

  /* -------------------------------------------------------- 6. CAMERA BAIT */
  {
    id: "camera_bait",
    label: "SECURITY RELAY",
    bounds: r(10, 27, 17, 33),
    brief: "CHECKPOINT OPENS WHILE SECURITY IS LOOKING ELSEWHERE",
    components: [
      // Only an ECHO's contact counts. Being seen yourself does not open the
      // checkpoint — it just tells MIMIC exactly where you are.
      {
        kind: "cameraTap",
        id: "bait_tap",
        emits: "bait.relay",
        label: "DECOY CONTACT",
        cameraId: "cam_security",
        target: "echo",
        holdSeconds: 9,
      },
    ],
  },

  /* -------------------------------------------------- 8. DOOR OVERRIDE BAIT */
  {
    id: "override_bait",
    label: "OVERRIDE BUFFER",
    bounds: r(10, 27, 17, 33),
    brief: "SERVICE HATCH FREE WHILE ITS OVERRIDE IS SPENT",
    components: [
      {
        kind: "abilityWindow",
        id: "override_window",
        emits: "override.spent",
        label: "OVERRIDE BUFFER",
        abilityId: "door_control",
      },
    ],
  },

  /* ------------------------------------------------------ 4. FOUR SIGNATURES */
  {
    id: "four_signatures",
    label: "SIGNATURE ARRAY",
    bounds: r(49, 3, 55, 12),
    brief: "FOUR TEMPORAL SIGNATURES, SIMULTANEOUS",
    components: [
      // Four corners of the array bay, far enough apart that no two can be held
      // by one body and close enough that three ECHOs plus you is a real plan.
      { kind: "scanner", id: "sig_a", emits: "sig.a", label: "PAD A", area: r(49, 3, 50, 4) },
      { kind: "scanner", id: "sig_b", emits: "sig.b", label: "PAD B", area: r(54, 3, 55, 4) },
      { kind: "scanner", id: "sig_c", emits: "sig.c", label: "PAD C", area: r(49, 9, 50, 10) },
      { kind: "scanner", id: "sig_d", emits: "sig.d", label: "PAD D", area: r(54, 9, 55, 10) },
      {
        kind: "latch",
        id: "sig_done",
        emits: "sig.ok",
        label: "SIGNATURE ARRAY",
        when: { all: ["sig.a", "sig.b", "sig.c", "sig.d"] },
        announce: "SUBJECT INSTANCES: IMPOSSIBLE",
        // Stage five, and the peak of the campaign: three ECHOs and you.
        completes: "bypass",
      },
    ],
  },

  /* ------------------------------------------------------- 7. MIMIC SCANNER */
  {
    id: "mimic_scanner",
    label: "CONTAINMENT ARCH",
    bounds: r(49, 10, 55, 12),
    brief: "ARCH READS CONTAINMENT-GRADE SIGNATURES ONLY",
    components: [
      {
        kind: "mimicScanner",
        id: "arch",
        emits: "arch.auth",
        label: "CONTAINMENT ARCH",
        // Straddles the only way in from the spine, so MIMIC following you into
        // the laboratory walks through it whether it means to or not. Baiting it
        // in on purpose is the intended play; blundering into it is the lesson.
        area: r(51, 11, 53, 12),
        // Long enough to be a plan rather than a scramble.
        holdSeconds: 16,
      },
      // Once cleared, the bay stays unsealed — including across RETRACE.
      //
      // Two reasons. Within a run, an authorisation that lapsed while the player
      // was inside a dead-end bay would shut them in. Across runs, the orchestra
      // behind this door needs three separate recordings made *inside* the bay,
      // and re-luring MIMIC through the arch before each one is repetition, not
      // a puzzle. Clearing it once is the achievement.
      {
        kind: "latch",
        id: "arch_latch",
        emits: "arch.ok",
        label: "RESTRICTED BAY",
        when: "arch.auth",
        announce: "CONTAINMENT CLEARANCE ACCEPTED",
        persistAcrossRuns: true,
        // The campaign's last required system, and the only one the player
        // cannot supply themselves — the arch reads a containment signature and
        // the only thing in the wing carrying one is the thing hunting them.
        completes: "clearance",
      },
    ],
  },

  /* --------------------------------------------------------- 9. THE ORCHESTRA */
  {
    id: "orchestra",
    label: "TEMPORAL LABORATORY",
    bounds: r(57, 3, 62, 12),
    brief: "FOUR PARTS, ONE PERFORMANCE",
    components: [
      // Part one: a relay somebody has to keep held down.
      {
        kind: "scanner",
        id: "orch_relay_a",
        emits: "orch.a",
        label: "RELAY A",
        area: r(58, 3, 59, 4),
      },
      // Part two: noise in the monitored corridor. A dash is the honest way to
      // make it, and the same dash is what pulls MIMIC off the player.
      {
        kind: "sound",
        id: "orch_noise",
        emits: "orch.b",
        label: "CORRIDOR IMPULSE",
        tx: 61,
        ty: 7,
        threshold: 1.1,
        holdSeconds: 12,
        accepts: ["dash", "sprint"],
      },
      // Part three: the second relay, at the far end from the first.
      {
        kind: "scanner",
        id: "orch_relay_b",
        emits: "orch.c",
        label: "RELAY B",
        area: r(58, 10, 59, 11),
      },
      // Part four: the living player at the console while the other three hold.
      {
        kind: "scanner",
        id: "orch_console",
        emits: "orch.d",
        label: "CENTRAL CONSOLE",
        area: r(61, 3, 62, 4),
      },
      {
        kind: "latch",
        id: "orchestra_done",
        emits: "orchestra.ok",
        label: "TEMPORAL OVERRIDE",
        when: { all: ["orch.a", "orch.b", "orch.c", "orch.d"] },
        announce: "OVERRIDE ACCEPTED",
      },
    ],
  },
];
