/** Central tuning table. Everything gameplay-facing that has a number lives here. */

export const TILE = 16;

/** Simulation runs at a fixed rate so ECHO recordings replay frame-exactly. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** Guard against spiral-of-death after a tab stall. */
export const MAX_TICKS_PER_FRAME = 5;

export const VIEW_W = 1280;
export const VIEW_H = 720;
/** Integer zoom keeps pixel art crisp. 1280/3 = 426px => ~26x15 tiles on screen. */
export const CAMERA_SCALE = 3;

export const PLAYER = {
  radius: 5,
  walkSpeed: 52,
  sprintSpeed: 88,
  /**
   * Sneaking. The third movement mode, and the only one that costs nothing but
   * time — sprint spends stamina, sneak spends the clock. Slow enough that using
   * it is a real commitment, fast enough that it is never the boring option.
   */
  sneakSpeed: 27,
  accel: 900,
  /** Seconds between footstep sound emissions. */
  stepIntervalWalk: 0.42,
  stepIntervalSprint: 0.26,
  /** Long, deliberate placement of the foot. */
  stepIntervalSneak: 0.72,
  interactRange: 22,
};

/**
 * Sprint is a resource, not a toggle. Unlimited sprinting makes the whole sound
 * system optional — you would simply outrun every consequence. Spending it costs
 * roughly twice what it earns back, so a sprint is a decision about the next ten
 * seconds, and a sprint used as deliberate bait is a decision you pay for.
 */
export const STAMINA = {
  max: 100,
  /** Sprint drain per second. ~3.4s of continuous sprint from full. */
  sprintDrain: 29,
  /** Seconds after the last spend before it starts refilling. */
  regenDelay: 1,
  /** Units per second. Full refill takes 5s. */
  regenRate: 20,
  /**
   * Once fully spent, movement abilities stay locked until this much is back —
   * without it you could stutter-sprint one frame at a time off an empty meter.
   */
  unlockAt: 30,
  /** Below this the meter starts pulsing to warn you. */
  lowAt: 35,
};

/**
 * The dash. Hold to charge, release to commit — the wind-up is the cost, and
 * it aims itself at whatever you are facing, so turning mid-charge is how you
 * pick the escape line. Charging slows you, which is what stops it from being a
 * free "always be charging" button.
 */
export const DASH = {
  /** Seconds of holding to reach full charge. */
  chargeSeconds: 0.55,
  /** Seconds the burst itself lasts. */
  duration: 0.15,
  /** Travel at a bare tap and at full charge, in pixels. 96 is six tiles. */
  distanceMin: 24,
  distanceMax: 96,
  /**
   * Stamina spent, scaled by how far the charge got. A maxed dash costs the
   * entire bar — it is the escape you get once, and it leaves you winded, so a
   * full charge is only ever available on a completely full meter.
   */
  costMin: 20,
  costMax: STAMINA.max,
  /** Movement multiplier while winding up. */
  chargeSlow: 0.42,
  /** Seconds before another dash may start. */
  recovery: 0.18,
  /** Charge below this is treated as a mis-tap and refunded. */
  minCharge: 0.12,
};

export const ECHO = {
  /** Hard cap from the design doc: 3 simultaneous ECHOs + the live player. */
  maxActive: 3,
  /** Longest single run that can be recorded, in seconds. */
  maxRunSeconds: 150,
  /** Seconds an ECHO stays dissipated after MIMIC touches it. */
  disruptSeconds: 4.5,
  radius: 5,
};

export const MIMIC = {
  radius: 6,
  patrolSpeed: 40,
  investigateSpeed: 56,
  chaseSpeed: 74,
  /** Vision cone: half-angle in radians and range in tiles. */
  coneHalfAngle: (52 * Math.PI) / 180,
  visionTiles: 9.5,
  /** Omni-directional "feel" radius — you cannot hug its back at zero range. */
  peripheralTiles: 1.8,
  turnRate: 3.2,
  /**
   * Seconds it keeps chasing the last known position after losing sight.
   *
   * Trimmed so breaking line of sight is a real escape rather than a delay. It
   * still searches afterwards — this only shortens the period where it runs
   * straight at where you were.
   */
  loseSightGrace: 2.0,
  searchSeconds: 9,
  catchRange: 9,
  /** Seconds MIMIC is stalled after dissipating an ECHO. */
  echoStall: 1.5,
  /** Seconds after a catch before it can catch again. */
  catchCooldown: 1.2,
  /** Seconds of immunity at the start of a run, so a respawn is never a trap. */
  respawnGrace: 2.5,
};

/**
 * Confirming the real Subject 047 — as opposed to an ECHO of them.
 *
 * This is what gates the RETRACE jam, so it is deliberately a buildup rather
 * than a switch: clipping the edge of the cone for a frame must not cost you the
 * ability to retrace, but standing in the open must. Only direct line of sight
 * to the living player counts; searching is not seeing, and an ECHO is never
 * mistaken for the real thing.
 */
export const DETECT = {
  /**
   * Seconds of clean continuous sight before detection confirms.
   *
   * Widened from 0.4. Below about half a second there is no time to react to
   * being spotted — you are caught before the tell finishes playing, which reads
   * as unfair rather than tense.
   */
  confirmSeconds: 0.75,
  /** Seconds of no sight for a partial buildup to drain away completely. */
  decaySeconds: 0.7,
  /** Seconds without direct sight before the RETRACE jam lifts. */
  releaseSeconds: 2.0,
};

export const SOUND = {
  /** Loudness budget in tiles. Sound spreads via Dijkstra; walls cost extra. */
  footstepWalk: 3.2,
  footstepSprint: 6.5,
  /**
   * A sneaking step barely clears the audible floor, so it dies within a tile or
   * two and never survives a wall. That is the whole trade: you can cross a room
   * MIMIC is standing in, if you are willing to spend twice as long doing it.
   */
  footstepSneak: 1.1,
  interact: 5.0,
  doorOpen: 7.0,
  alarm: 22.0,
  retrace: 9.0,
  /** Extra propagation cost for passing through a solid tile / closed door. */
  wallCost: 3.4,
  doorCost: 2.2,
  /** Below this residual loudness a sound is inaudible. */
  audibleFloor: 0.35,
};

export const LIGHT = {
  playerRadiusTiles: 8.5,
  /** How bright a tile stays once seen but no longer visible. */
  memoryLevel: 0.16,
  ambient: 0.05,
};

/**
 * Temporal Stability — how many captures a timeline survives.
 *
 * Three, by explicit request.
 *
 * It was briefly four: a collapse wipes every ECHO, and the mid-campaign gates
 * need two or three recorded runs to set up, so a bad streak could erase a long
 * stretch of setup. Three is the number the game is meant to be played at, and
 * the recovery problem belongs to the checkpointing, not to the life count.
 */
export const STABILITY = {
  max: 3,
  /** Seconds the catch stinger holds before the run restarts. */
  catchFreeze: 1.1,
  collapseFreeze: 3.0,
};

/**
 * The campaign, in order. Two tracks are interleaved deliberately:
 *
 *   intake   1 ECHO   puzzle — a past self holds the clamp
 *   power    1 plate  gate   — a past self holds the plate
 *   cascade  2 ECHOs  puzzle — two clamps loaded while you throw the breaker
 *   auth     2 plates gate
 *   bypass   3 ECHOs  puzzle — four signatures, three of them recorded
 *   contain  3 plates gate
 *   escape
 *
 * Each puzzle stage teaches the idea; the plate gate that follows makes you use
 * it under pressure. The ECHO count climbs 1, 2, 3 on both tracks at once, so by
 * the lift you are running a full cast of three plus yourself.
 */
export const OBJECTIVE_ORDER = [
  "intake",
  "power",
  "cascade",
  "auth",
  "bypass",
  "clearance",
  "containment",
  "escape",
] as const;
export type ObjectiveId = (typeof OBJECTIVE_ORDER)[number];

/**
 * The systems the lift actually waits on.
 *
 * Deliberately shorter than the full list. Every stage costs recorded runs, and
 * the first cut of the campaign asked for twelve of them — one to three per
 * stage, each starting with a long walk from the reclamation bay. That is a lot
 * of setup before any thinking happens.
 *
 * These three keep the escalation intact with no repetition: one ECHO, then two,
 * then three plus you. The stages left off the list are still fully playable and
 * still open their own doors — they are simply optional now, so a player can
 * take the short road or the whole facility.
 */
/**
 * One stage per idea, and the last one is the interesting one.
 *
 * The first cut of the required road was three variations on "occupy N floor
 * tiles at once" — escalation of quantity, not of idea, and by the third the
 * player is doing logistics rather than thinking. Worse, the puzzles that could
 * only exist in *this* game were all optional, so finishing the campaign never
 * showed you one.
 *
 *   intake     one ECHO holds a clamp        — teaches the verb
 *   auth       two pressure plates at once   — the classic, under time pressure
 *   clearance  lure MIMIC through the arch   — the hunter is the key
 *
 * The four-pad signature array is still there and still worth doing; it is just
 * no longer the thing standing between you and the lift.
 */
export const REQUIRED_OBJECTIVES = ["intake", "auth", "clearance"] as const;
