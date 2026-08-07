/**
 * MIMIC.
 *
 * The state machine from the brief — Patrol, Alert, Chase, Investigate — plus a
 * Stalled state for the moment after it dissipates an ECHO. What makes it feel
 * like it is learning is not the machine but its inputs: the patrol route, the
 * zone it camps, the alcoves it sweeps, how much it trusts ECHO noise and how
 * hard it commits to a chase all come from the Strategy handed in at run start.
 * Swap the Strategy and the same code hunts you differently.
 *
 * It cannot see through walls, it cannot see you well in an unlit alcove, and it
 * cannot follow you through a security gate you closed behind you — pathfinding
 * treats a held-plate gate as solid.
 */
import { DETECT, MIMIC, TILE } from "../core/constants";
import { approachAngle, dist } from "../core/math";
import { moveCircle } from "../systems/collide";
import { type Cone, coneVisibility } from "../systems/los";
import { findPath } from "../systems/pathfind";
import type { SoundBus, SoundEvent, SoundSource } from "../systems/sound";
import type { Strategy } from "../systems/strategist";
import { type Level, tileCenter } from "../world/level";

export type MimicState =
  | "patrol"
  | "alert"
  | "chase"
  | "investigate"
  | "stalled"
  /** Committed to a chokepoint ahead of the player, via the ability system. */
  | "intercept";

export interface SensedEcho {
  id: string;
  x: number;
  y: number;
  /** ECHOs that are dissipated cannot be seen or bumped into. */
  solid: boolean;
}

export interface MimicSenses {
  level: Level;
  player: { x: number; y: number; /** standing in an unlit alcove */ hidden: boolean };
  echoes: SensedEcho[];
  sounds: SoundBus;
  strategy: Strategy;
  /**
   * 0..1 trust in a noise, supplied by the analysis adaptations. A pattern
   * MIMIC has heard many times before scores low. Defaults to full trust.
   */
  soundConfidence?: (ev: SoundEvent) => number;
  /**
   * Temporary facility-emergency multipliers. MIMIC knows nothing about Hunt
   * Mode — it just moves and searches harder when handed larger numbers. Only
   * ever multipliers: never extra senses, never knowledge it has not earned.
   */
  boost?: { speed: number; search: number; persistence: number };
}

export interface MimicOutcome {
  caughtPlayer: boolean;
  /** Id of an ECHO it touched this tick. */
  disruptedEcho: string | null;
  /** True while it has direct sight of the player. */
  seesPlayer: boolean;
  /** Set for one tick when it reacts to a noise an ECHO made. */
  divertedByEcho: boolean;
  /** Set for one tick when the state changed, for logging. */
  changedTo: MimicState | null;
  /** Set for one tick when detection of the real player completes. */
  detectedPlayer: boolean;
  /** Set for one tick when it has gone long enough without seeing the player. */
  lostPlayer: boolean;
}

/** How sure MIMIC is that it is looking at the living player. */
export type DetectionPhase = "undetected" | "suspicious" | "detected";

/** A noise quieter than this is treated as background and ignored. */
const HEAR_THRESHOLD = 1.1;
/** How close a waypoint counts as reached, in pixels. */
const WAYPOINT_EPS = 5;
/** How close a patrol/search goal counts as reached, in pixels. */
const GOAL_EPS = 12;
/** Seconds the body waits after the eye has snapped to something. */
const REACTION_HOLD = 0.18;
/** Seconds the eye stays fixed on a stimulus before the state machine resumes. */
const GAZE_HOLD = 0.4;
/**
 * Patrol-seconds spent walking to one stop before MIMIC gives up on it and moves
 * to the next.
 *
 * Sixty is deliberately far more than any leg needs on paper — the longest
 * crossing in the wing is about twenty seconds of walking. The slack is for
 * interruptions: a leg is not walked in one go, it is walked in fragments
 * between investigations that each drag MIMIC somewhere else, so wall-clock
 * progress along a leg is a fraction of the time budgeted to it. At thirty this
 * expired mid-crossing and MIMIC abandoned the laboratory leg every circuit,
 * which is the one stop the containment arch depends on it making.
 */
const PATROL_LEG_SECONDS = 60;

export class Mimic {
  x = 0;
  y = 0;
  /** Aim of the vision cone, in radians. */
  facing = 0;
  /**
   * Where the eye is pointing, as distinct from where the body is turned.
   *
   * The eye snaps; the body follows. A noise makes MIMIC *look* almost
   * instantly, then rotate over the next fraction of a second — which is what
   * separates a machine that is reacting from a sprite that is sliding.
   *
   * Critically, this drives only the sprite. The vision cone stays welded to
   * `facing`, so the eye can never imply MIMIC sees somewhere it does not. The
   * gaze is a tell about intent; the cone is the truth about perception.
   */
  gaze = 0;
  private gazeTarget = 0;
  /**
   * Seconds the eye stays committed to what it was just told to look at.
   *
   * Without this the snap does not exist. `updateGaze` rebuilds `gazeTarget`
   * from the state machine every single frame, so `lookAt` — the whole "the eye
   * goes first" mechanism — was overwritten on the very next tick and the eye
   * simply eased along with the body. Measured against a noise directly behind
   * it: the eye needed to travel 2.93 radians, moved 0.62, wobbled, and drifted
   * back. It never once pointed at the sound.
   */
  private gazeHold = 0;
  /**
   * Seconds of visible hesitation. Set when something it trusted turns out to
   * be wrong — an ECHO it chased, or the player slipping out of sight. It stops,
   * and the eye flicks between the possibilities.
   */
  confusionT = 0;
  state: MimicState = "patrol";

  /** 0..1 buildup toward confirming the real player. */
  detection = 0;
  /**
   * Latches once detection completes and holds until DETECT.releaseSeconds pass
   * without direct sight. This — not the state machine — is what jams RETRACE,
   * so an ECHO sighting can never trip it and a search can never sustain it.
   */
  playerDetected = false;
  /** Seconds since it last had direct line of sight to the real player. */
  unseenT = Number.POSITIVE_INFINITY;
  /** Short spike when the jam is established, for the eye art. */
  focusPulse = 0;

  /* ---- ability command surface -------------------------------------------
   * The adaptation system steers MIMIC through these fields and methods only.
   * It never reaches into the state machine, so the base behaviour is exactly
   * what it was before abilities existed. */

  /** Seconds it will stand still to scan. Perception continues; movement stops. */
  holdT = 0;
  /**
   * The beat between noticing something and acting on it.
   *
   * The eye snaps to a noise on the frame it happens; the body is held here for
   * a fraction of a second before it is allowed to turn and go. That pause is
   * the whole difference between a machine executing a state transition and one
   * that appears to be deciding — without it, MIMIC spinning instantly toward a
   * sound behind it reads as a script rather than as attention.
   *
   * Perception keeps running throughout: this stops the body, never the senses.
   */
  reactT = 0;
  /** 0..1 reduced awareness while bound to a facility subsystem. */
  distracted = 0;
  /** Seconds left committed to an intercept point. */
  private interceptT = 0;

  /** Seconds of chase left after losing sight. */
  private graceT = 0;
  private searchT = 0;
  /** Seconds left frozen after dissipating an ECHO. */
  stallT = 0;
  private catchCd = 0;

  lastKnown: { x: number; y: number } | null = null;
  /** What pulled it to its current alert target. */
  lastHeardSource: SoundSource | null = null;

  private route: { x: number; y: number }[] = [];
  private routeIdx = 0;
  /** Patrol-seconds spent on the current leg. See `patrolStep`. */
  private legT = 0;
  private searchQueue: { x: number; y: number }[] = [];
  private goal: { x: number; y: number } | null = null;
  private path: { x: number; y: number }[] = [];
  private repathT = 0;

  /** 0..1, drives the art. */
  get alerted(): boolean {
    return this.state === "chase" || this.state === "alert" || this.state === "intercept";
  }

  get detectionPhase(): DetectionPhase {
    if (this.playerDetected) return "detected";
    return this.detection > 0 ? "suspicious" : "undetected";
  }

  get stalled(): boolean {
    return this.stallT > 0;
  }

  /**
   * Rebuild the patrol route from a strategy. Zone centres are preferred over
   * the level's fixed nodes so a plan that says "cover the west corridor"
   * actually changes where it walks.
   */
  configure(level: Level, strategy: Strategy): void {
    const pts: { x: number; y: number }[] = [];
    for (const id of strategy.patrolZones) {
      const c = level.zoneCenter(id);
      if (c) pts.push(c);
    }
    if (strategy.guardZone) {
      const g = level.zoneCenter(strategy.guardZone);
      // Camping is expressed as revisiting the guard zone between other stops,
      // rather than standing still — a motionless MIMIC is trivially avoided.
      if (g) {
        const woven: { x: number; y: number }[] = [];
        for (const p of pts) {
          woven.push(p, g);
        }
        pts.length = 0;
        pts.push(...woven);
      }
    }
    if (pts.length < 2) {
      for (const n of level.patrolNodes) pts.push(tileCenter(n.tx, n.ty));
    }

    // Mandatory stops go in whatever the strategy chose.
    //
    // The route above is built purely from strategy zones, and the level's own
    // patrol nodes are only a fallback for when that list is too thin. A node the
    // campaign *depends* on being visited would therefore be dead data — which is
    // exactly what happened to the containment arch: MIMIC patrolled seven zones
    // for four minutes and never once entered the laboratory, leaving a required
    // objective unreachable. Woven in near the front rather than appended, so it
    // is reached without walking the entire loop first.
    for (const n of level.patrolNodes) {
      if (!n.mandatory) continue;
      const p = tileCenter(n.tx, n.ty);
      if (pts.some((q) => dist(q.x, q.y, p.x, p.y) < TILE)) continue;
      pts.splice(Math.min(1, pts.length), 0, p);
    }

    this.route = pts;
    this.routeIdx = 0;
    this.legT = 0;
    this.goal = null;
    this.path = [];
  }

  reset(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.facing = 0;
    this.gaze = 0;
    this.gazeTarget = 0;
    this.gazeHold = 0;
    this.confusionT = 0;
    this.state = "patrol";
    this.detection = 0;
    this.playerDetected = false;
    this.unseenT = Number.POSITIVE_INFINITY;
    this.focusPulse = 0;
    this.holdT = 0;
    this.reactT = 0;
    this.distracted = 0;
    this.interceptT = 0;
    this.graceT = 0;
    this.searchT = 0;
    this.stallT = 0;
    // A beat of grace at the start of every run. Without it a player who
    // respawns near an alerted MIMIC can be caught again before they have taken
    // a step, and three of those in a row ends the timeline through no decision
    // of theirs. It costs nothing anywhere else — MIMIC still has to reach them.
    this.catchCd = MIMIC.respawnGrace;
    this.lastKnown = null;
    this.lastHeardSource = null;
    this.routeIdx = 0;
    this.legT = 0;
    this.searchQueue = [];
    this.goal = null;
    this.path = [];
    this.repathT = 0;
  }

  /** External alert — used by security cameras that spot the player. */
  alertTo(x: number, y: number, source: SoundSource = "world"): void {
    if (this.state === "chase") return;
    // A camera contact turns the head first, exactly like a noise does.
    this.lookAt(x, y);
    this.lastKnown = { x, y };
    this.lastHeardSource = source;
    this.setState("alert");
    this.setGoal(x, y);
  }

  /** Ability command: redirect the current pursuit without changing state. */
  commandGoal(x: number, y: number): void {
    this.setGoal(x, y);
  }

  /** Ability command: go and wait at a chokepoint instead of trailing behind. */
  beginIntercept(x: number, y: number, seconds: number): void {
    this.interceptT = seconds;
    this.setState("intercept");
    this.setGoal(x, y);
  }

  /** Ability command: treat this position as worth a look. */
  investigateAt(x: number, y: number): void {
    if (this.state === "chase") return;
    this.lastKnown = { x, y };
    this.setState("alert");
    this.setGoal(x, y);
  }

  update(dt: number, s: MimicSenses): MimicOutcome {
    const out: MimicOutcome = {
      caughtPlayer: false,
      disruptedEcho: null,
      seesPlayer: false,
      divertedByEcho: false,
      changedTo: null,
      detectedPlayer: false,
      lostPlayer: false,
    };

    this.catchCd = Math.max(0, this.catchCd - dt);
    this.focusPulse = Math.max(0, this.focusPulse - dt * 2.5);
    this.updateGaze(dt);

    if (this.stallT > 0) {
      // Dissipating an ECHO costs it a moment — the window the tactic buys you.
      // It is not looking at anything while stunned, so the jam clock runs.
      this.loseSight(dt, out);
      this.stallT -= dt;
      if (this.stallT <= 0) {
        this.state = this.lastKnown ? "investigate" : "patrol";
        this.searchT = MIMIC.searchSeconds * 0.5;
        out.changedTo = this.state;
      }
      return out;
    }

    const before = this.state;

    /* ------------------------------------------------------------- seeing */

    const cone: Cone = {
      x: this.x,
      y: this.y,
      facing: this.facing,
      halfAngle: MIMIC.coneHalfAngle,
      // Bound to a subsystem, it is not watching the room as carefully.
      range: MIMIC.visionTiles * TILE * (1 - this.distracted * 0.45),
      peripheral: MIMIC.peripheralTiles * TILE,
    };

    let vis = coneVisibility(s.level, cone, s.player.x, s.player.y);
    // An unlit alcove does not make you invisible, only slow to resolve.
    if (s.player.hidden) vis *= 0.3;
    out.seesPlayer = vis > 0;

    if (vis > 0) {
      this.unseenT = 0;
      this.lastKnown = { x: s.player.x, y: s.player.y };
      // A marginal sighting — cone edge, long range, shadow — takes longer to
      // resolve than a clear one, so cover still buys you time.
      this.detection = Math.min(
        1,
        this.detection + (dt / DETECT.confirmSeconds) * (0.55 + 0.45 * vis),
      );
    } else {
      this.loseSight(dt, out);
    }

    if (this.detection >= 1) {
      // Re-acquiring inside the release window puts it straight back on you,
      // but the "jammed" announcement only fires on the first confirmation.
      if (!this.playerDetected) {
        this.playerDetected = true;
        this.focusPulse = 1;
        out.detectedPlayer = true;
      }
      this.setState("chase");
      this.graceT = MIMIC.loseSightGrace * (0.6 + 0.8 * s.strategy.aggression) * (s.boost?.persistence ?? 1);
    }

    // ECHOs are chased too, but only when the real thing is not in view.
    if (this.state !== "chase" && vis <= 0) {
      for (const e of s.echoes) {
        if (!e.solid) continue;
        if (coneVisibility(s.level, cone, e.x, e.y) <= 0) continue;
        this.lastKnown = { x: e.x, y: e.y };
        this.lastHeardSource = "echo";
        this.setState("alert");
        this.setGoal(e.x, e.y);
        break;
      }
    }

    /* ------------------------------------------------------------ hearing */

    // Deaf to its own footsteps, or it investigates itself forever.
    const heard = s.sounds.loudestAt(s.level, this.x, this.y, "mimic");
    if (heard && heard.level >= HEAR_THRESHOLD) {
      const ev = heard.event;
      // Skepticism is the counter to bait: a player who leans on recorded noise
      // trains it to discount recorded noise. Familiarity stacks on top — the
      // same trick in the same place wears out on its own.
      const familiarity = s.soundConfidence?.(ev) ?? 1;
      const trust = (ev.source === "echo" ? 1 - s.strategy.echoSkepticism : 1) * familiarity;
      if (heard.level * trust >= HEAR_THRESHOLD && this.state !== "chase") {
        // The eye snaps to the noise before the body has begun to turn.
        this.lookAt(ev.x, ev.y);
        this.lastKnown = { x: ev.x, y: ev.y };
        this.lastHeardSource = ev.source;
        if (this.state !== "alert") this.reactT = REACTION_HOLD;
        this.setState("alert");
        this.setGoal(ev.x, ev.y);
        if (ev.source === "echo") {
          out.divertedByEcho = true;
          // It committed to a copy. A beat of hesitation is how the player is
          // told, without a word of UI, that the trick landed.
          this.confusionT = Math.max(this.confusionT, 0.9);
        }
      }
    }

    /* ------------------------------------------------------- state update */

    switch (this.state) {
      case "chase": {
        if (vis > 0) {
          this.graceT = MIMIC.loseSightGrace * (0.6 + 0.8 * s.strategy.aggression) * (s.boost?.persistence ?? 1);
          this.setGoal(s.player.x, s.player.y);
        } else {
          this.graceT -= dt;
          if (this.lastKnown) this.setGoal(this.lastKnown.x, this.lastKnown.y);
          if (this.graceT <= 0) {
            this.beginSearch(s);
          }
        }
        break;
      }
      case "alert": {
        if (this.goal && dist(this.x, this.y, this.goal.x, this.goal.y) < GOAL_EPS) {
          this.beginSearch(s);
        }
        break;
      }
      case "intercept": {
        // Hold the chokepoint for a while, then fall back to a normal search.
        // If it sees the player on the way, the chase branch takes over.
        this.interceptT -= dt;
        const arrived =
          this.goal !== null && dist(this.x, this.y, this.goal.x, this.goal.y) < GOAL_EPS;
        if (this.interceptT <= 0 || (arrived && this.interceptT <= 3)) {
          this.beginSearch(s);
        }
        break;
      }
      case "investigate": {
        this.searchT -= dt;
        if (this.searchT <= 0) {
          this.setState("patrol");
          this.lastKnown = null;
          this.goal = null;
        } else if (!this.goal || dist(this.x, this.y, this.goal.x, this.goal.y) < GOAL_EPS) {
          const next = this.searchQueue.shift();
          if (next) this.setGoal(next.x, next.y);
          else this.sweepInPlace(dt);
        }
        break;
      }
      default: {
        this.patrolStep(dt);
        break;
      }
    }

    /* --------------------------------------------------------- locomotion */

    // Scanning abilities root it in place; a subsystem link drags on it.
    this.holdT = Math.max(0, this.holdT - dt);
    this.reactT = Math.max(0, this.reactT - dt);
    if (this.holdT <= 0 && this.reactT <= 0) {
      const base =
        this.state === "chase"
          ? MIMIC.chaseSpeed
          : this.state === "alert" || this.state === "intercept"
            ? MIMIC.investigateSpeed
            : this.state === "investigate"
              ? MIMIC.investigateSpeed * 0.8
              : MIMIC.patrolSpeed;
      this.steer(dt, s.level, base * (1 - this.distracted * 0.4) * (s.boost?.speed ?? 1));
    }

    /* ------------------------------------------------------------ contact */

    for (const e of s.echoes) {
      if (!e.solid) continue;
      if (dist(this.x, this.y, e.x, e.y) > MIMIC.catchRange) continue;
      out.disruptedEcho = e.id;
      this.stallT = MIMIC.echoStall;
      this.state = "stalled";
      break;
    }

    if (
      !out.disruptedEcho &&
      this.catchCd <= 0 &&
      dist(this.x, this.y, s.player.x, s.player.y) <= MIMIC.catchRange
    ) {
      out.caughtPlayer = true;
      this.catchCd = MIMIC.catchCooldown;
    }

    if (this.state !== before) out.changedTo = this.state;
    return out;
  }

  /* ------------------------------------------------------------- internals */

  /**
   * A tick with no direct sight of the real player: drain the buildup and run
   * the release clock. Deliberately independent of the state machine — MIMIC can
   * keep searching long after the jam has lifted.
   */
  private loseSight(dt: number, out: MimicOutcome): void {
    this.unseenT += dt;
    this.detection = Math.max(0, this.detection - dt / DETECT.decaySeconds);
    if (this.playerDetected && this.unseenT >= DETECT.releaseSeconds) {
      this.playerDetected = false;
      out.lostPlayer = true;
      // Losing something it had confirmed is the other honest moment of doubt.
      this.confusionT = Math.max(this.confusionT, 1.2);
    }
  }

  private setState(next: MimicState): void {
    if (this.state === next) return;
    this.state = next;
    this.path = [];
    this.repathT = 0;
  }

  /** Lost the target: sweep the strategist's alcoves, then the last sighting. */
  private beginSearch(s: MimicSenses): void {
    this.setState("investigate");
    this.searchT =
      MIMIC.searchSeconds * (0.7 + 0.6 * s.strategy.aggression) * (s.boost?.search ?? 1);
    this.searchQueue = [];
    for (const id of s.strategy.searchSpots) {
      const spot = s.level.hideSpots.find((h) => h.id === id);
      if (spot) this.searchQueue.push(tileCenter(spot.tx, spot.ty));
    }
    if (this.lastKnown) this.searchQueue.unshift({ ...this.lastKnown });
    const first = this.searchQueue.shift();
    if (first) this.setGoal(first.x, first.y);
  }

  /**
   * Walk the route, and — critically — keep walking it.
   *
   * This used to advance the index only on arrival. That reads as correct and is
   * not, because patrolling is the state MIMIC is in least: noise and camera
   * contacts drag it into `investigate` for most of a run, and every return to
   * patrol restarted the current leg from wherever the search happened to end.
   * A stop far enough away was therefore never reached, the index never moved,
   * and MIMIC spent entire runs re-targeting route[0] while the rest of the
   * route — including stops it is required to make — was dead data. Measured at
   * four minutes of play: index 0 of 4, every time.
   *
   * So a leg it cannot finish now expires. The budget is counted in patrol
   * seconds rather than wall-clock, since that is the time actually spent
   * walking, and is long enough that only a genuinely unreachable stop hits it.
   */
  private patrolStep(dt: number): void {
    if (this.route.length === 0) return;
    const target = this.route[this.routeIdx % this.route.length];
    const arrived = dist(this.x, this.y, target.x, target.y) < GOAL_EPS;

    this.legT += dt;
    if (arrived || this.legT > PATROL_LEG_SECONDS) {
      this.routeIdx = (this.routeIdx + 1) % this.route.length;
      this.legT = 0;
    }

    // Re-asserted every tick: `setGoal` keeps the existing path when the target
    // has not really moved, so this is free until the index actually changes.
    const next = this.route[this.routeIdx % this.route.length];
    this.setGoal(next.x, next.y);
  }

  /**
   * Points the eye at a world position, instantly. The body catches up on its
   * own over the following fraction of a second, which is the tell.
   */
  lookAt(x: number, y: number): void {
    this.gazeTarget = Math.atan2(y - this.y, x - this.x);
    // A real snap: the eye is already there on the frame the noise happens.
    // Easing toward it reads as the eye being dragged round by the body, which
    // is the opposite of the impression this is here to create.
    this.gaze = this.gazeTarget;
    this.gazeHold = GAZE_HOLD;
  }

  /**
   * Advances the eye.
   *
   * Four behaviours, in priority order: hesitate, scan while searching, track
   * whatever it is chasing, and otherwise settle back onto the body heading.
   */
  private updateGaze(dt: number): void {
    this.confusionT = Math.max(0, this.confusionT - dt);
    this.gazeHold = Math.max(0, this.gazeHold - dt);

    // Committed to something it just noticed. Leaving the target alone here is
    // what lets the snap survive long enough to be seen.
    if (this.gazeHold > 0) return;

    if (this.confusionT > 0) {
      // Flicking between possibilities. Deliberately not smooth — it reads as
      // indecision rather than as a scan.
      const flick = Math.sin(this.confusionT * 17) > 0 ? 0.85 : -0.85;
      this.gazeTarget = this.facing + flick;
    } else if (this.state === "investigate") {
      // Searching. The eye sweeps well outside the cone, which is exactly the
      // read the player needs: it is looking around because it does not know.
      this.gazeTarget = this.facing + Math.sin(this.searchT * 2.1) * 1.15;
    } else if (this.goal && (this.state === "chase" || this.state === "alert")) {
      this.gazeTarget = Math.atan2(this.goal.y - this.y, this.goal.x - this.x);
    } else {
      this.gazeTarget = this.facing;
    }

    // Roughly four times the body turn rate. The lead is the whole point.
    this.gaze = approachAngle(this.gaze, this.gazeTarget, MIMIC.turnRate * 4 * dt);
  }

  /** Nothing left to check: turn on the spot so the cone still covers ground. */
  private sweepInPlace(dt: number): void {
    this.facing += MIMIC.turnRate * 0.45 * dt;
  }

  private setGoal(x: number, y: number): void {
    if (this.goal && dist(this.goal.x, this.goal.y, x, y) < TILE * 0.75) {
      this.goal.x = x;
      this.goal.y = y;
      return;
    }
    this.goal = { x, y };
    this.path = [];
    this.repathT = 0;
  }

  private steer(dt: number, level: Level, speed: number): void {
    if (!this.goal) return;
    // Hesitation is a full stop, not a slow-down. A machine that keeps gliding
    // forward while its eye darts about does not read as uncertain — it reads
    // as broken. Standing still for a beat is the entire tell.
    if (this.confusionT > 0) return;

    this.repathT -= dt;
    if (this.path.length === 0 || this.repathT <= 0) {
      this.path = findPath(level, this.x, this.y, this.goal.x, this.goal.y) ?? [];
      this.repathT = 0.4;
    }

    while (this.path.length > 0 && dist(this.x, this.y, this.path[0].x, this.path[0].y) < WAYPOINT_EPS) {
      this.path.shift();
    }

    const wp = this.path[0] ?? this.goal;
    const dx = wp.x - this.x;
    const dy = wp.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.01) return;

    const stepLen = Math.min(d, speed * dt);
    const moved = moveCircle(level, this.x, this.y, MIMIC.radius, (dx / d) * stepLen, (dy / d) * stepLen);
    // Wedged against geometry the current path does not account for; drop it and
    // let the next tick solve a fresh one.
    if (moved.hitX && moved.hitY) this.path = [];
    this.x = moved.x;
    this.y = moved.y;

    this.facing = approachAngle(this.facing, Math.atan2(dy, dx), MIMIC.turnRate * dt);
  }
}
