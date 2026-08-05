/**
 * The simulation.
 *
 * One fixed 60 Hz tick drives everything, because ECHO playback is frame-indexed
 * against that clock — a variable timestep would desynchronise a recording from
 * the plate it is supposed to be holding.
 *
 * Run lifecycle, and what survives each kind of ending:
 *
 *   RETRACE (hold R)  -> run is saved as an ECHO. Objectives kept.
 *   CAUGHT            -> one Temporal Stability point lost, no ECHO created.
 *                        Deliberately worse than retracing, which is what makes
 *                        pressing R voluntarily the interesting decision.
 *   COLLAPSE (0/3)    -> ECHOs wiped, stability restored, MIMIC's memory decays
 *                        but is not cleared. Objectives and explored map persist.
 *
 * MIMIC's memory is the one thing that never resets, which is the premise.
 */
import {
  LIGHT,
  MIMIC as MIMIC_TUNING,
  type ObjectiveId,
  REQUIRED_OBJECTIVES,
  PLAYER,
  SOUND,
  STABILITY,
  TILE,
} from "../core/constants";
import type { Input } from "../core/input";
import { clamp, damp, dist } from "../core/math";
import { Rng } from "../core/rng";
import { createAbilities } from "../ai/ability-defs";
import {
  type AbilityId,
  type AbilityWorld,
  AbilityManager,
  type CameraSighting,
  type Disturbance,
  type MimicFx,
} from "../ai/abilities";
import { ADAPTATION_LABEL, Adaptation } from "../ai/adaptation";
import { AnalysisBook } from "../ai/analysis";
import { MimicEyeController } from "../render/mimic-eye";
import { Mimic } from "../entities/mimic";
import { Player } from "../entities/player";
import { Sfx } from "../systems/audio";
import { MusicManager } from "../systems/music";
import { AlertManager } from "./alert";
import { HUNT, HuntManager, type HuntReason } from "./hunt";
import { EchoManager, Recorder } from "../systems/echo";
import { type Cone, FogField, coneVisibility } from "../systems/los";
import { MimicMemory, type RunOutcome } from "../systems/memory";
import {
  SoundBus,
  type SoundEvent,
  type SoundKind,
  footstepLoudness,
} from "../systems/sound";
import { type Strategy, type StrategyContext, Strategist, localStrategy } from "../systems/strategist";
import { Level, NEIGHBOURS4, toTileX, toTileY, tileCenter } from "../world/level";
import type { Door, Prop } from "../world/props";
import { Tile, footstepGain, isWalkableTile } from "../world/tiles";
import { WING01 } from "../world/wing01";
import { WING01_PUZZLES } from "../world/puzzles-wing01";
import type { PuzzleBody, PuzzleContext } from "../puzzle/components";
import { PuzzleSystem } from "../puzzle/system";
import { Settings } from "../core/settings";
import { StoryManager, type StoryContext } from "../story/manager";
import { OPENING_SECONDS } from "../story/content";
import { behaviourLines, restorationLines, trialLines } from "../story/dossier";
import { buildOldEcho, type OldEchoDef } from "../story/old-echo";

export type Phase = "playing" | "caught" | "collapse" | "escaped";

export type LogTone = "info" | "warn" | "good";

export interface LogLine {
  text: string;
  tone: LogTone;
  age: number;
}

/** Seconds R must be held before the run is banked as an ECHO. */
const RETRACE_HOLD = 1.0;
/** The three gated systems; "escape" is the state after all of them. */
const CORE_OBJECTIVES: ObjectiveId[] = [...REQUIRED_OBJECTIVES];
/** How close a body must be to a plate's centre to weigh it down, in pixels. */
const PLATE_REACH = TILE * 0.62;
/** Auto-hatch trigger radius, in pixels. */
const HATCH_REACH = TILE * 1.7;
const DOOR_RATE = 7;
const LOG_LIFETIME = 7;
/** How many times any one hint may appear before it stops nagging. */
const HINT_REPEATS = 3;

export class Game {
  readonly level = new Level(WING01);
  readonly player = new Player();
  readonly mimic = new Mimic();
  readonly echoes = new EchoManager();
  readonly recorder = new Recorder();
  readonly sounds = new SoundBus();
  readonly fog: FogField;
  readonly memory = MimicMemory.load();
  readonly strategist: Strategist;
  readonly sfx = new Sfx();
  readonly music = new MusicManager();
  readonly hunt = new HuntManager();
  readonly alert = new AlertManager();
  readonly puzzles = new PuzzleSystem(WING01_PUZZLES);
  readonly story = new StoryManager();
  settings = new Settings();

  /** Carries the player's accessibility choices into a new run. */
  adoptSettings(s: Settings): void {
    this.settings = s;
  }

  readonly objectives = new Set<ObjectiveId>();
  phase: Phase = "playing";
  stability = STABILITY.max;
  run = 1;
  runTime = 0;
  /** Wall-clock since boot; drives ambient animation. */
  elapsed = 0;
  freezeT = 0;
  /** 0..1 baseline screen corruption from lost stability. */
  glitch = 0;
  /** 0..1 transient spike, decays after each catch. */
  glitchPulse = 0;
  retraceHold = 0;
  log: LogLine[] = [];

  /** Brief centred status flash — the jam/restore announcements. */
  notice: { text: string; t: number; tone: LogTone } | null = null;
  /** 0..1 spike when a jammed RETRACE attempt is refused. */
  jamBuzz = 0;
  /** 0..1 camera kick, decaying. Physical punctuation for hits and bursts. */
  shake = 0;
  /**
   * 1 -> 0 across the RETRACE flash. The game is named after this moment, so it
   * gets a real one: a white-cyan bloom, reversed streaks and a scanline tear,
   * over in well under a second. Long enough to feel like the timeline folding,
   * short enough to press twenty times in a row without resenting it.
   */
  retraceFlash = 0;

  /**
   * Seconds into the boot sequence. The simulation is frozen until it finishes,
   * so the facility can introduce itself before Subject 047 can walk away.
   *
   * Starts *finished*. The opening is presentation, and the presentation layer
   * asks for it via `beginOpening()` — a headless Game has no business refusing
   * to simulate for eleven seconds because a title card is playing.
   */
  openingT = OPENING_SECONDS;
  /**
   * Seconds into the closing sequence. The game is named after a mechanic, and
   * the ending is where that mechanic gets its last word — so it plays out
   * rather than cutting to a stats card.
   */
  endingT = 0;
  /** Skippable only once it has been seen through — never on a first run. */
  openingSkippable = false;

  /** Called by the boot gate. Runs the AXIOM start-up before control begins. */
  beginOpening(seen: boolean): void {
    this.openingT = 0;
    this.openingSkippable = seen;
  }
  private jamNoticeCd = 0;
  private chargeTick = 0;

  /** Prop the player could interact with right now, if any. */
  focusProp: Prop | null = null;
  focusBlocked = false;

  /**
   * What the player is standing on or beside, spelled out — which gate a plate
   * feeds and how that gate is doing. Without this the plates are unreadable:
   * the gate they open is usually well outside the fog radius, so there is no
   * way to connect cause to effect by looking.
   */
  statusLine: string | null = null;
  /**
   * A nudge about what to *do*, shown under the status line. Separate from
   * statusLine on purpose: one says what is happening, the other says what would
   * help, and a beginner needs both without them competing for the same row.
   */
  hint: { key: string; text: string; t: number } | null = null;
  private readonly hintsSeen = new Map<string, number>();
  /** Facility wiring readout, shown for a while after using the schematic. */
  schematic: { lines: string[]; t: number } | null = null;

  /** plate id -> the door it feeds. Built once from the level's own rules. */
  private readonly plateGate = new Map<string, Door>();

  /* ---- MIMIC adaptation system ------------------------------------------ */

  readonly adaptation: Adaptation;
  readonly analysis = new AnalysisBook();
  readonly abilities: AbilityManager;
  /** Transient ability visuals for the renderer. */
  readonly mimicFx: MimicFx[] = [];
  /**
   * MIMIC's eye. Presentation only — it reads the simulation and never writes
   * to it, apart from `reactionHold`, which is the deliberate beat between the
   * eye noticing something and the body being allowed to act on it.
   */
  readonly eye = new MimicEyeController();
  /** Ability that fired this tick, handed to the eye then cleared. */
  private eyeAbility: MimicFx["kind"] | null = null;
  /** Toggled with F1; gates the developer overlay. */
  debug = false;

  private readonly rng = new Rng(0x5eed51);
  private readonly abilityWorld: AbilityWorld;
  /** Camera reports for this tick, consumed by Camera Link. */
  private frameSightings: CameraSighting[] = [];
  /** Recent world activity, for Deep Scan. A motionless player leaves none. */
  private traces: (Disturbance & { age: number })[] = [];
  /** zone id -> seconds of remaining brownout. */
  private readonly surges = new Map<string, number>();

  /** Plate bookkeeping for this tick, used to spot ECHO tactics. */
  private platesHeld = 0;
  private platesHeldByEcho = 0;
  private appliedStrategy: Strategy | null = null;
  private alarmCd = 0;
  /** Previous MIMIC position, for deriving its speed and step cadence. */
  private mimicLastX = 0;
  private mimicLastY = 0;
  private mimicStepT = 0;

  constructor() {
    // Derived from the level's own door rules, so the readouts and the pip
    // markings can never drift out of sync with the actual wiring.
    for (const d of this.level.doors) {
      if (d.rule.kind !== "plates") continue;
      for (const id of d.rule.plates) this.plateGate.set(id, d);
    }

    this.fog = new FogField(this.level.w, this.level.h);
    this.adaptation = new Adaptation(this.memory.data.adaptation);
    this.abilityWorld = this.makeAbilityWorld();
    this.abilities = new AbilityManager(
      createAbilities(this.analysis),
      this.memory.data.abilities as AbilityId[],
    );
    this.strategist = new Strategist(localStrategy(this.memory, this.strategyContext()));
    this.player.reset(this.level.playerSpawn.x, this.level.playerSpawn.y);
    this.mimic.reset(this.level.mimicSpawn.x, this.level.mimicSpawn.y);
    this.applyStrategy();
    this.strategist.plan(this.memory, this.strategyContext());
    this.pushLog("SUBJECT 047 ACTIVE // WING-01", "info");
    this.pushLog("HOLD [R] TO RETRACE", "info");
  }

  /* ------------------------------------------------------- plate wiring */

  /** How many of a gate's plates are currently held, and how many it needs. */
  gateStatus(door: Door): { held: number; needed: number } | null {
    if (door.rule.kind !== "plates") return null;
    const plates = door.rule.plates;
    let held = 0;
    for (const id of plates) {
      if (this.level.propById.get(id)?.active) held++;
    }
    return { held, needed: plates.length };
  }

  /** The gate a plate feeds, with its live state. Drives the pips and readouts. */
  plateStatus(plateId: string): { label: string; held: number; needed: number } | null {
    const door = this.plateGate.get(plateId);
    if (!door) return null;
    const s = this.gateStatus(door);
    if (!s) return null;
    return { label: door.label ?? door.id.toUpperCase(), ...s };
  }

  /** The facility's own wiring, generated from the level so it cannot go stale. */
  wiringLines(): string[] {
    const lines: string[] = [];
    for (const d of this.level.doors) {
      if (d.rule.kind === "plates") {
        const names = d.rule.plates
          .map((id) => this.level.propById.get(id)?.label ?? id)
          .join(" + ");
        lines.push(`${d.label ?? d.id} <- ${names}`);
      } else if (d.rule.kind === "flags") {
        lines.push(`${d.label ?? d.id} <- ${d.rule.flags.join(" + ").toUpperCase()}`);
      }
    }
    return lines;
  }

  /**
   * Names whatever the player is standing on or next to. Plates report their
   * gate's progress even though that gate is usually far out of sight, which is
   * the only thing that makes them learnable.
   */
  private updateStatusLine(ptx: number, pty: number): void {
    this.statusLine = null;

    // Inside a puzzle room, say what the room wants and how far along it is.
    // This states the rule, never the solution — the brief is explicit that the
    // player should never have to guess what a device does, only how to satisfy
    // it with the bodies available.
    const here = this.puzzles.puzzlesAt(this.player.x, this.player.y, TILE);
    if (here.length > 0) {
      // One context for the whole readout. Building one per component allocated
      // a fresh closure set for every machine in the room, every tick.
      const pctx = this.puzzleContext(0);
      // Every component's own word for "nothing is happening". A machine at rest
      // must not read as a machine mid-operation, or the room looks busy when it
      // is idle and the player learns to ignore the readout.
      const IDLE = new Set(["idle", "quiet", "empty", "closed", "open", "clear"]);

      let best: { label: string; parts: string[] } | null = null;
      for (const puzzle of here) {
        const parts: string[] = [];
        for (const c of this.puzzles.componentsOf(puzzle.id)) {
          const s = c.status(pctx);
          if (s && !IDLE.has(s)) parts.push(`${c.label} ${s}`);
        }
        // Rooms share machines, so show whichever one is actually doing
        // something rather than whichever happens to be listed first.
        if (!best || parts.length > best.parts.length) {
          best = { label: puzzle.label, parts };
        }
      }

      if (best) {
        const def = here.find((p) => p.label === best!.label);
        const brief = def?.brief ?? "";
        this.statusLine = best.parts.length
          ? `${best.label} — ${best.parts.slice(0, 3).join("  ")}`
          : `${best.label} — ${brief}`;

        // If the room is asking for more bodies than are standing in it, say so
        // in the one sentence a new player actually needs.
        if (def && !this.puzzles.solvedFor(def.id)) {
          this.offerHint(
            `puzzle:${def.id}`,
            Game.PUZZLE_HINTS[def.id] ?? Game.DEFAULT_PUZZLE_HINT,
          );
        }
        return;
      }
    }

    // Standing on a plate.
    //
    // Written as a sentence, not a readout. "PLATE A -> GATE ALPHA 1/1" is
    // precise and teaches nothing: a new player cannot tell from it whether they
    // have finished, what the other number means, or what to do next. Saying
    // what the gate is doing, and what it still wants, does all three.
    for (const p of this.level.props) {
      if (p.kind !== "plate" || p.tx !== ptx || p.ty !== pty) continue;
      const s = this.plateStatus(p.id);
      if (!s) {
        this.statusLine = p.label ?? null;
        return;
      }
      if (s.held >= s.needed) {
        this.statusLine = `${p.label} — ${s.label} IS OPEN WHILE THIS IS HELD (${s.held}/${s.needed})`;
      } else {
        const missing = s.needed - s.held;
        this.statusLine = `${p.label} — ${s.label} NEEDS ${missing} MORE PLATE${missing === 1 ? "" : "S"} HELD (${s.held}/${s.needed})`;
        this.offerHint(
          `plate:${s.label}`,
          "ONE OF YOU CANNOT HOLD THEM ALL — HOLD [R] TO RECORD THIS ATTEMPT",
        );
      }
      return;
    }

    // Standing at a gate.
    let nearest: Door | null = null;
    let bestD = TILE * 2.6;
    for (const d of this.level.doors) {
      if (d.rule.kind === "auto") continue;
      const c = tileCenter(d.tx, d.ty);
      const gap = dist(this.player.x, this.player.y, c.x, c.y);
      if (gap < bestD) {
        bestD = gap;
        nearest = d;
      }
    }
    if (!nearest) return;

    if (nearest.rule.kind === "plates") {
      const s = this.gateStatus(nearest);
      if (s) {
        const names = nearest.rule.plates
          .map((id) => this.level.propById.get(id)?.label?.replace("PLATE ", "") ?? id)
          .join(", ");
        this.statusLine =
          s.held >= s.needed
            ? `${nearest.label} IS OPEN (${s.held}/${s.needed})`
            : `${nearest.label} NEEDS ${s.needed} PLATE${s.needed === 1 ? "" : "S"} HELD AT ONCE (${s.held}/${s.needed}) — ${names}`;
        if (s.held < s.needed && s.needed > 1) {
          this.offerHint(
            `gate:${nearest.id}`,
            `RECORD A RUN HOLDING ONE, THEN HOLD THE OTHER YOURSELF`,
          );
        }
      }
    } else if (nearest.rule.kind === "flags") {
      const missing = nearest.rule.flags.filter((f) => !this.objectives.has(f));
      const done = nearest.rule.flags.length - missing.length;
      this.statusLine = missing.length
        ? `${nearest.label} — ${done}/${nearest.rule.flags.length} SYSTEMS ONLINE`
        : `${nearest.label} IS OPEN`;
    } else if (nearest.rule.kind === "signal") {
      this.statusLine = nearest.powered
        ? `${nearest.label ?? nearest.id.toUpperCase()} IS OPEN`
        : `${nearest.label ?? nearest.id.toUpperCase()} IS SEALED`;
    }
  }

  /**
   * Offers a one-line nudge about *what to do*, as opposed to what is happening.
   *
   * Shown only a few times each. A hint that repeats forever becomes furniture
   * the player stops reading, and one that never appears leaves a beginner
   * staring at a closed door with no idea that recording a run is the answer.
   * Three showings is enough to land the idea and few enough to stop nagging.
   */
  private offerHint(key: string, text: string): void {
    const seen = this.hintsSeen.get(key) ?? 0;
    if (seen >= HINT_REPEATS) return;
    // Only re-arm once the player has been away from this hint for a moment,
    // so standing still does not burn all three showings in half a second.
    if (this.hint && this.hint.key === key) return;
    this.hintsSeen.set(key, seen + 1);
    this.hint = { key, text, t: 5 };
  }

  /* ------------------------------------------------- MIMIC ability system */

  /**
   * The facility, as far as an adaptation is allowed to touch it. Everything
   * MIMIC can do to the world goes through here, which keeps the reach of the
   * ability system auditable in one place.
   */
  private makeAbilityWorld(): AbilityWorld {
    return {
      level: this.level,
      lockDoor: (id, seconds) => this.lockDoor(id, seconds),
      lockableDoors: () => this.lockableDoors(),
      surgeZone: (zoneId, seconds) => {
        this.surges.set(zoneId, Math.max(this.surges.get(zoneId) ?? 0, seconds));
        this.pushLog(`POWER FLUCTUATION // ${this.level.zoneLabel(zoneId)}`, "warn");
      },
      cameraSightings: () => this.frameSightings,
      disturbancesNear: (x, y, radius) =>
        this.traces
          .filter((t) => dist(t.x, t.y, x, y) <= radius)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 5),
      notice: (text) => this.setNotice(text, "warn"),
      log: (text) => this.pushLog(text, "warn"),
      play: (kind, volume) => this.sfx.play(kind, volume),
      emitFx: (fx) => {
        this.mimicFx.push({ ...fx, age: 0 });
        if (this.mimicFx.length > 12) this.mimicFx.shift();
        // The eye gives every ability its own tell, so it needs to know which
        // one fired rather than just that something did.
        this.eyeAbility = fx.kind;
      },
    };
  }

  /** Doors MIMIC is permitted to seal right now. */
  private lockableDoors(): string[] {
    return this.level.doors
      .filter((d) => d.mimicControllable && d.lockedT <= 0)
      .map((d) => d.id);
  }

  /**
   * Seal a door, but only if the player can still finish the run afterwards.
   * MIMIC is allowed to be cruel; it is not allowed to end the game by accident.
   */
  private lockDoor(id: string, seconds: number): boolean {
    const d = this.level.doorById.get(id);
    if (!d?.mimicControllable || d.lockedT > 0) return false;

    d.lockedT = seconds;
    if (!this.playerCanStillFinish()) {
      d.lockedT = 0;
      return false;
    }
    this.pushLog(`SECURITY LOCK // ${d.label ?? d.id.toUpperCase()}`, "warn");
    return true;
  }

  /**
   * Flood from the player across walkable tiles, treating MIMIC-locked doors as
   * solid and every other door as open. If the next objective and the lift are
   * both still reachable, no lock combination can strand the run.
   */
  private playerCanStillFinish(): boolean {
    const start = this.level.idx(toTileX(this.player.x), toTileY(this.player.y));
    const seen = new Set<number>([start]);
    const stack = [start];
    const lockedTiles = new Set(
      this.level.doors.filter((d) => d.lockedT > 0).map((d) => this.level.idx(d.tx, d.ty)),
    );

    while (stack.length > 0) {
      const i = stack.pop()!;
      const tx = i % this.level.w;
      const ty = (i / this.level.w) | 0;
      for (const [dx, dy] of NEIGHBOURS4) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (!this.level.inBounds(nx, ny)) continue;
        if (!isWalkableTile(this.level.at(nx, ny))) continue;
        const ni = this.level.idx(nx, ny);
        if (seen.has(ni) || lockedTiles.has(ni)) continue;
        seen.add(ni);
        stack.push(ni);
      }
    }

    const needed: Prop[] = [];
    const next = this.level.props.find((p) => p.objective === this.nextObjective);
    if (next) needed.push(next);
    const exit = this.level.props.find((p) => p.kind === "exit");
    if (exit) needed.push(exit);
    return needed.every((p) => seen.has(this.level.idx(p.tx, p.ty)));
  }

  /** True while the zone's lights and cameras are browned out by a surge. */
  isSurged(zoneId: string | null): boolean {
    return zoneId !== null && (this.surges.get(zoneId) ?? 0) > 0;
  }

  private updateAbilities(dt: number): void {
    this.adaptation.tick(dt);

    for (const [zone, t] of this.surges) {
      const next = t - dt;
      if (next <= 0) this.surges.delete(zone);
      else this.surges.set(zone, next);
    }
    for (const d of this.level.doors) d.lockedT = Math.max(0, d.lockedT - dt);

    for (let i = this.traces.length - 1; i >= 0; i--) {
      const t = this.traces[i];
      t.age += dt;
      t.strength -= dt * 0.22;
      if (t.strength <= 0) this.traces.splice(i, 1);
    }
    for (let i = this.mimicFx.length - 1; i >= 0; i--) {
      const fx = this.mimicFx[i];
      fx.age += dt;
      if (fx.age >= fx.life) this.mimicFx.splice(i, 1);
    }

    const developed = this.abilities.advanceUnlocks(this.adaptation, this.elapsed);
    if (developed.length > 0) {
      // Never name the tool. The player is meant to meet it in the corridor.
      this.setNotice("SECURITY ADAPTATION COMPLETE", "warn", 2.2);
      this.pushLog("MIMIC // COUNTERMEASURE DEVELOPED", "warn");
    }

    const ptx = toTileX(this.player.x);
    const pty = toTileY(this.player.y);
    this.abilities.update(
      {
        dt,
        mimic: this.mimic,
        adaptation: this.adaptation,
        memory: this.memory,
        strategy: this.strategist.current,
        rng: this.rng,
        player: {
          x: this.player.x,
          y: this.player.y,
          hidden: this.level.at(ptx, pty) === Tile.Shadow,
          zone: this.level.zoneIdAt(ptx, pty),
        },
        playerConfirmed: this.mimic.playerDetected,
        echoes: this.echoes.echoes.map((e) => ({
          id: e.rec.id,
          x: e.x,
          y: e.y,
          solid: e.isSolid,
        })),
        world: this.abilityWorld,
      },
      this.elapsed,
    );

    const fired = this.abilities.justFired;
    if (fired) this.mimic.focusPulse = Math.max(this.mimic.focusPulse, 0.7);
  }

  /* ------------------------------------------------------ hunt & atmosphere */

  /**
   * Hunt Mode is always earned. A system coming online is the facility noticing
   * you are winning; a high adaptation mass is MIMIC deciding it has seen
   * enough. Both are meaningful, neither is random.
   */
  private considerHunt(reason: HuntReason): void {
    if (!this.hunt.canStart()) return;
    if (reason === "adaptation" && this.adaptation.mass() < HUNT.adaptationTrigger) return;
    if (this.hunt.start(reason)) this.onHuntStarted();
  }

  private onHuntStarted(): void {
    this.music.onHuntStart();
    this.setNotice("CONTAINMENT PROTOCOL: HUNTER", "warn", 2.4);
    this.alert.announce("FACILITY ALERT LEVEL: MAXIMUM");
    this.pushLog("CONTAINMENT PROTOCOL ACTIVE", "warn");
    this.sfx.play("alarm", 0.7);

    // The facility seals what it safely can. The lock guard still applies, so
    // an alternate route always survives.
    for (const id of this.lockableDoors().slice(0, 2)) this.lockDoor(id, HUNT.duration);
  }

  private onHuntEnded(): void {
    this.music.onHuntEnd();
    this.alert.announce("CONTAINMENT PROTOCOL: STANDBY");
    this.pushLog("ALERT LEVEL // NOMINAL", "good");
    for (const d of this.level.doors) d.lockedT = Math.min(d.lockedT, 0.5);
  }

  /** Drives the score, the emergency lighting and the hunt timer. */
  private updateAtmosphere(dt: number): void {
    this.hunt.tick(dt);
    if (this.hunt.justEnded) this.onHuntEnded();

    // MIMIC learning enough about you is itself an escalation trigger. This used
    // to also require lockdown — every objective complete — which made it
    // unreachable for almost the whole game.
    if (this.adaptation.mass() >= HUNT.adaptationTrigger) {
      this.considerHunt("adaptation");
    }

    this.alert.update(dt, this.hunt.active ? 1 : this.mimic.playerDetected ? 0.35 : 0);

    this.music.setThreat({
      distanceTiles: dist(this.player.x, this.player.y, this.mimic.x, this.mimic.y) / TILE,
      hasLineOfSight: this.mimic.unseenT <= 0,
      detected: this.mimic.playerDetected,
      chasing: this.mimic.state === "chase" || this.mimic.state === "intercept",
      hunting: this.hunt.active,
      corruption: 1 - this.stability / STABILITY.max,
    });
    this.music.update(dt, this.mimic.unseenT <= 0);
  }

  /* ------------------------------------------------------------ objectives */

  get nextObjective(): ObjectiveId {
    for (const o of CORE_OBJECTIVES) if (!this.objectives.has(o)) return o;
    return "escape";
  }

  get lockdown(): boolean {
    return CORE_OBJECTIVES.every((o) => this.objectives.has(o));
  }

  /**
   * Where the next objective lives. Puzzle stages have no single device to point
   * at, so they name their room directly — without this the HUD hint and MIMIC's
   * guard zone both go blank for three of the seven stages.
   */
  /**
   * The one sentence a new player standing in a puzzle room actually needs.
   *
   * Almost every machine in the wing is solved by putting a past self somewhere,
   * so that is the default. The containment arch is the exception, and the
   * default is worse than nothing there: it tells the player to bank a run,
   * which can never solve an arch that reads containment signatures the player
   * is incapable of producing. A required stage cannot afford a hint that sends
   * beginners in the wrong direction.
   */
  private static readonly DEFAULT_PUZZLE_HINT =
    "HOLD [R] TO BANK THIS RUN — YOUR PAST SELF REPLAYS IT ALONGSIDE YOU";
  private static readonly PUZZLE_HINTS: Record<string, string> = {
    mimic_scanner: "THE ARCH ONLY READS MIMIC — MAKE NOISE HERE AND LET IT WALK THROUGH",
  };

  private static readonly PUZZLE_ZONES: Partial<Record<ObjectiveId, string>> = {
    intake: "generator",
    cascade: "generator",
    bypass: "lab",
    // The containment arch has no device the player can operate, so without an
    // entry here the pointer went blank on a *required* stage. It also aims
    // MIMIC's guard zone at the laboratory while clearance is outstanding,
    // which matters more than the pointer does: the arch only reads MIMIC's own
    // signature, so the stage cannot complete unless MIMIC actually comes here.
    clearance: "lab",
  };

  private objectiveZone(): string | null {
    const next = this.nextObjective;
    const puzzleZone = Game.PUZZLE_ZONES[next];
    if (puzzleZone) return puzzleZone;
    const prop =
      next === "escape"
        ? this.level.props.find((p) => p.kind === "exit")
        : this.level.props.find((p) => p.objective === next);
    if (!prop) return null;
    return this.level.zoneIdAt(prop.tx, prop.ty);
  }

  private strategyContext(): StrategyContext {
    return {
      zones: this.level.zones.map((z) => z.id),
      hideSpots: this.level.hideSpots.map((h) => h.id),
      objectivesComplete: [...this.objectives],
      nextObjective: this.nextObjective,
      objectiveZone: this.objectiveZone(),
      lockdown: this.lockdown,
    };
  }

  private applyStrategy(): void {
    this.appliedStrategy = this.strategist.current;
    this.mimic.configure(this.level, this.strategist.current);
  }

  /* ------------------------------------------------------------------ tick */

  tick(dt: number, input: Input | null): void {
    this.elapsed += dt;

    // The boot sequence holds the simulation. Nothing ticks, so a player who
    // mashes keys through it does not arrive mid-corridor with no idea how.
    if (this.openingT < OPENING_SECONDS) {
      this.openingT += dt;
      if (this.openingSkippable && input?.consumePress("Escape")) {
        this.openingT = OPENING_SECONDS;
      }
      if (this.openingT >= OPENING_SECONDS) {
        this.openingSkippable = true;
        this.story.flags.raise("openingSeen");
        this.story.announce(this.storyContext(dt), "welcome");
      }
      return;
    }

    // A terminal pauses the world while it is open. Reading is not a moment to
    // be ambushed in, and the brief asks for story that never costs a run.
    if (this.story.terminal) {
      this.story.tick(this.storyContext(dt));
      if (input?.consumePress("KeyE") || input?.consumePress("Escape")) {
        this.story.closeTerminal();
      }
      return;
    }
    // Cleared at the START of the next tick, not the end of this one, so a hunt
    // that begins mid-tick is still observable once the tick returns.
    this.hunt.endTick();
    this.glitchPulse = Math.max(0, this.glitchPulse - dt * 1.6);
    this.shake = Math.max(0, this.shake - dt * 3.4);
    // ~0.8s of fold. Fast decay so it punctuates rather than interrupts.
    this.retraceFlash = Math.max(0, this.retraceFlash - dt * 1.25);
    this.alarmCd = Math.max(0, this.alarmCd - dt);
    if (this.hint) {
      this.hint.t -= dt;
      if (this.hint.t <= 0) this.hint = null;
    }
    if (this.notice) {
      this.notice.t -= dt;
      if (this.notice.t <= 0) this.notice = null;
    }
    if (this.schematic) {
      this.schematic.t -= dt;
      if (this.schematic.t <= 0) this.schematic = null;
    }
    for (let i = this.log.length - 1; i >= 0; i--) {
      this.log[i].age += dt;
      if (this.log[i].age > LOG_LIFETIME) this.log.splice(i, 1);
    }

    // A plan that arrived mid-run takes effect the moment it lands, so the
    // upgrade from LOCAL to CLAUDE is something you can feel.
    if (this.strategist.current !== this.appliedStrategy) {
      this.applyStrategy();
      this.pushLog(`MIMIC LINK // ${this.strategist.current.source.toUpperCase()}`, "warn");
    }

    if (this.phase !== "playing") {
      // The score keeps running through a freeze so the collapse can be heard
      // decaying rather than being cut off.
      this.music.update(dt);
      if (this.phase === "escaped") this.endingT += dt;
      this.alert.update(dt, 0);
      this.freezeT -= dt;
      if (this.freezeT <= 0) this.resolveFreeze();
      return;
    }

    this.runTime += dt;

    /* ---------------------------------------------------------- the player */

    this.handleRetraceHold(dt, input);
    const step = this.player.update(dt, this.level, input?.state ?? null);
    if (step.stepped) {
      this.emitFootstep(
        this.player.x,
        this.player.y,
        this.player.sprinting,
        "player",
        this.player.sneaking,
      );
    }
    if (step.justExhausted) this.pushLog("STAMINA DEPLETED", "warn");
    if (step.charging) this.chargeTick += dt;
    else this.chargeTick = 0;
    // The wind-up ticks audibly so you can hear the charge without watching it.
    if (step.charging && this.chargeTick > 0.09) {
      this.chargeTick = 0;
      this.sfx.play("charge", 0.4 + this.player.charge * 0.5);
    }
    if (step.dashFailed) this.sfx.play("drained", 0.6);
    if (step.dashed) {
      // Scaled by what the burst cost, so a full-bar dash kicks and a hop does not.
      this.shake = Math.max(this.shake, 0.18 + 0.3 * this.player.staminaSpentOnDash);
      // A real world noise: recorded, replayed by ECHOs, and heard by MIMIC.
      this.emitSound({
        x: this.player.x,
        y: this.player.y,
        loudness: SOUND.footstepSprint * 1.15,
        kind: "dash",
        source: "player",
      });
      this.recorder.action({
        kind: "sound",
        sound: "dash",
        loudness: SOUND.footstepSprint * 1.15,
        x: this.player.x,
        y: this.player.y,
      });
    }
    this.recorder.sample(
      this.player.x,
      this.player.y,
      this.player.dir,
      this.player.moving,
      this.player.sprinting,
      this.player.sneaking,
    );

    this.updateFocus();
    if (input?.consumePress("KeyE")) this.tryInteract();

    /* ----------------------------------------------------------- the ECHOs */

    this.echoes.advanceAll(dt);
    for (const e of this.echoes.echoes) {
      for (const s of e.firedSounds) {
        this.emitSound({
          x: s.x,
          y: s.y,
          loudness: s.loudness,
          kind: s.sound,
          source: "echo",
          ownerId: e.rec.id,
        });
      }
      for (const propId of e.firedInteractions) this.applyInteract(propId, "echo");
    }

    /* ----------------------------------------------------------- the world */

    this.updateProps(dt);
    // Props settle, then components read the world and raise signals, then the
    // doors evaluate against the bus — all inside this tick, so standing on a
    // pad opens its door immediately rather than a frame later.
    this.puzzles.update(this.puzzleContext(dt));
    this.collectPuzzleObjectives();
    this.updateDoors(dt);

    // After the world settles, so a plate the player is standing on reports its
    // gate's state this tick rather than last tick's.
    this.updateStatusLine(toTileX(this.player.x), toTileY(this.player.y));

    /* --------------------------------------------------- the adaptations */

    // Runs before perception so a scan hold or an intercept order is already in
    // effect when the state machine reads it this tick.
    this.updateAbilities(dt);

    /* ------------------------------------------------------------- the AI */

    const ptx = toTileX(this.player.x);
    const pty = toTileY(this.player.y);
    const onShadow = this.level.at(ptx, pty) === Tile.Shadow;

    const outcome = this.mimic.update(dt, {
      level: this.level,
      player: { x: this.player.x, y: this.player.y, hidden: onShadow },
      echoes: this.echoes.echoes.map((e) => ({
        id: e.rec.id,
        x: e.x,
        y: e.y,
        solid: e.isSolid,
      })),
      sounds: this.sounds,
      strategy: this.strategist.current,
      // Familiarity from the analysis adaptations. Never an identification —
      // just how tired MIMIC is of hearing this exact trick.
      soundConfidence: (ev) =>
        ev.source === "echo" && ev.ownerId
          ? this.analysis.echoConfidence(ev.ownerId, ev.x, ev.y, ev.kind)
          : this.analysis.soundConfidence(ev.x, ev.y, ev.kind),
      boost: this.hunt.bonus,
    });

    if (outcome.detectedPlayer) {
      this.story.flags.raise("firstDetection");
      // Being seen is the only thing that gives MIMIC an opening to speak, and
      // it only takes one if the next line is something it has actually earned.
      this.story.offerMimicLine(this.storyContext(dt));
      // Short glitch on the frame the link drops — deliberately much smaller
      // than the stability corruption a capture produces.
      this.glitchPulse = Math.max(this.glitchPulse, 0.45);
      this.setNotice("RETRACE SIGNAL JAMMED", "warn");
      this.sfx.play("jam", 0.8);
      this.pushLog("SUBJECT 047 CONFIRMED // LINK JAMMED", "warn");
      this.music.onDetection();
      this.alert.announce("SUBJECT 047 LOCATED");
    }
    if (outcome.lostPlayer) {
      this.setNotice("RETRACE SIGNAL RESTORED", "good", 1.5);
      this.sfx.play("interact", 0.4);
      this.pushLog("TEMPORAL LINK STABLE", "good");
      // Deliberately does not calm the score. A search still sounds dangerous,
      // and MIMIC closing back in is what makes the relief false.
      this.music.onLostSight();
    }

    if (outcome.disruptedEcho) {
      const hit = this.echoes.echoes.find((e) => e.rec.id === outcome.disruptedEcho);
      if (hit && hit.phase !== "disrupted") {
        hit.disrupt();
        this.emitSound({
          x: hit.x,
          y: hit.y,
          loudness: SOUND.interact,
          kind: "impact",
          source: "world",
        });
        this.pushLog("ECHO DISSIPATED", "warn");
      }
    }

    /* ------------------------------------------------- perception & memory */

    // A brownout in the player's zone shrinks how far they can see. Navigation
    // gets harder — but the zone's cameras are down for the same window.
    const litRadius =
      LIGHT.playerRadiusTiles * (this.isSurged(this.level.zoneIdAt(ptx, pty)) ? 0.55 : 1);
    this.fog.compute(this.level, this.player.x, this.player.y, litRadius);
    this.memory.noteZone(this.level.zoneIdAt(ptx, pty));
    this.detectTactics(dt, onShadow, outcome.divertedByEcho, ptx, pty);

    this.emitMimicFootsteps(dt);
    this.updateEye(dt);

    if (outcome.caughtPlayer) this.onCaught();

    this.updateAtmosphere(dt);
    this.story.tick(this.storyContext(dt));

    this.sounds.endTick(dt);
    this.echoes.endTick();
  }

  /**
   * Feeds MIMIC's eye and plays whatever it asks for.
   *
   * Everything here is read from the simulation that has already run this tick,
   * so the eye can only ever reflect a decision MIMIC actually made. The one
   * exception is `reactionHold`, which the Mimic reads back: that is the beat
   * between the eye noticing something and the body being allowed to turn.
   */
  private updateEye(dt: number): void {
    const m = this.mimic;
    // What it is currently interested in. An ECHO it has not seen through is
    // the interesting case, because that is when the eye should look unsure.
    const target =
      m.playerDetected
        ? "player"
        : m.lastHeardSource === "echo"
          ? "echo"
          : m.lastHeardSource
            ? "sound"
            : "none";

    this.eye.update(dt, {
      state: m.state,
      detection: m.detection,
      playerDetected: m.playerDetected,
      confusionT: m.confusionT,
      focusPulse: m.focusPulse,
      hunt: this.hunt.active,
      power: this.abilities.powerFraction,
      drain: this.abilities.drain,
      target,
      // What MIMIC actually believes about you, not a number invented for the
      // animation — the same figure the facility's own dossier prints.
      predictionConfidence: this.memory.knowledge() / 100,
      jamming: this.jamBuzz > 0.01,
      ability: this.eyeAbility,
    });
    this.eyeAbility = null;

    // Eye sounds are deliberately tiny. MIMIC is frightening because it is
    // quiet, and a machine that chirps constantly is not.
    const cue = this.eye.consumeCue();
    if (cue === "snap") this.sfx.play("eyeSnap", 0.5);
    else if (cue === "lock") this.sfx.play("eyeLock", 0.7);
    else if (cue === "predict") this.sfx.play("eyePredict", 0.45);
    else if (cue === "fail") this.sfx.play("eyeFail", 0.5);
  }

  /* --------------------------------------------------------------- puzzles */

  /**
   * The world as a puzzle component is allowed to see it.
   *
   * Note what `bodies` contains: the living player *and* every solid ECHO,
   * undifferentiated. A scanner pad genuinely cannot tell which of the four
   * signatures standing on it is the one with a pulse — which is the premise
   * the whole laboratory is built on.
   */
  private puzzleContext(dt: number): PuzzleContext {
    const bodies: PuzzleBody[] = [
      { x: this.player.x, y: this.player.y, kind: "player", id: "player" },
    ];
    for (const e of this.echoes.echoes) {
      if (!e.isSolid) continue;
      bodies.push({ x: e.x, y: e.y, kind: "echo", id: e.rec.id });
    }

    return {
      dt,
      elapsed: this.elapsed,
      bus: this.puzzles.bus,
      bodies,
      mimic: {
        x: this.mimic.x,
        y: this.mimic.y,
        state: this.mimic.state,
        alerted: this.mimic.alerted,
      },
      heardAt: (x, y, kinds) => {
        const heard = this.sounds.loudestMatching(this.level, x, y, kinds ?? null);
        return heard
          ? { loudness: heard.level, kind: heard.event.kind, source: heard.event.source }
          : null;
      },
      cameraSaw: (cameraId) => {
        const hit = this.frameSightings.find((s) => s.cameraId === cameraId);
        return hit ? hit.target : null;
      },
      abilityOnCooldown: (id) => this.abilities.onCooldown(id as AbilityId),
      propActive: (id) => this.level.propById.get(id)?.active === true,
      log: (text, tone) => this.pushLog(text, tone ?? "info"),
      notice: (text, tone, seconds) => this.setNotice(text, tone, seconds),
      play: (kind, volume) => this.sfx.play(kind, volume),
    };
  }

  /* -------------------------------------------------------------- interact */

  private updateFocus(): void {
    let best: Prop | null = null;
    let bestD = PLAYER.interactRange;
    for (const p of this.level.props) {
      if (!p.label) continue;
      // Plates are named but not interactable — they respond to weight, not to
      // [E]. Their readout goes through the status line instead.
      if (p.kind === "plate") continue;
      const c = tileCenter(p.tx, p.ty);
      const d = dist(this.player.x, this.player.y, c.x, c.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    this.focusProp = best;
    this.focusBlocked = best ? !this.requirementsMet(best) : false;
  }

  private requirementsMet(p: Prop): boolean {
    if (p.kind === "exit") return this.lockdown;
    return (p.requires ?? []).every((r) => this.objectives.has(r));
  }

  private tryInteract(): void {
    const p = this.focusProp;
    if (!p) return;

    // Story terminals are readable regardless of facility preconditions — a log
    // is a log, and gating lore behind progress means most players never see it.
    if (this.openStoryTerminal(p.id)) return;

    if (!this.requirementsMet(p)) {
      this.pushLog(
        p.kind === "exit" ? "LIFT LOCKED // SYSTEMS INCOMPLETE" : "ACCESS DENIED // PRECONDITION",
        "warn",
      );
      return;
    }

    // Recorded before the effect, so the ECHO re-performs it at the same tick.
    this.recorder.action({
      kind: "interact",
      propId: p.id,
      x: this.player.x,
      y: this.player.y,
    });
    this.emitSound({
      x: this.player.x,
      y: this.player.y,
      loudness: SOUND.interact,
      kind: "interact",
      source: "player",
    });
    this.applyInteract(p.id, "player");
  }

  private applyInteract(propId: string, by: "player" | "echo"): void {
    const p = this.level.propById.get(propId);
    if (!p) return;
    if (!this.requirementsMet(p)) return;

    if (p.kind === "exit") {
      if (by === "player") this.onEscaped();
      return;
    }

    // The schematic prints the facility's own wiring. It is the diegetic answer
    // to "which plate opens which gate" — read it once and the wing is legible.
    if (p.id === "wiring_schematic") {
      p.active = true;
      if (by === "player") {
        this.schematic = { lines: this.wiringLines(), t: 9 };
        this.sfx.play("interact", 0.5);
        this.pushLog("SCHEMATIC RETRIEVED", "good");
      }
      return;
    }

    if (p.active) return;
    p.active = true;
    p.since = 0;

    if (p.objective) this.completeObjective(p.objective, p.label ?? p.id);
  }

  /**
   * Brings a facility system online for good.
   *
   * Reached from two places: flipping an objective device, and solving a puzzle
   * whose latch names a system. They are the same event as far as the campaign
   * is concerned — which is what makes the puzzle wings stages of the game
   * rather than optional rooms off to one side.
   */
  private completeObjective(id: ObjectiveId, label: string): void {
    if (this.objectives.has(id)) return;
    this.objectives.add(id);
    this.pushLog(`${label} // ONLINE`, "good");
    this.music.onStoryEvent();
    // A system coming online is the facility realising it is losing. This is
    // the main, earned Hunt Mode trigger.
    this.considerHunt("objective");
    if (this.lockdown) this.pushLog("ALL SYSTEMS CLEAR // LIFT BULKHEAD UNSEALED", "good");
  }

  /** Puzzles that have just come good bring their facility system online. */
  private collectPuzzleObjectives(): void {
    for (const latch of this.puzzles.objectiveLatches()) {
      if (latch.isLatched && latch.completes) {
        this.completeObjective(latch.completes, latch.label);
      }
    }
  }

  /* ----------------------------------------------------------------- world */

  private updateProps(dt: number): void {
    this.platesHeld = 0;
    this.platesHeldByEcho = 0;
    this.frameSightings = [];

    for (const p of this.level.props) {
      p.since += dt;

      if (p.kind === "plate") {
        const c = tileCenter(p.tx, p.ty);
        let weight = 0;
        let echoWeight = 0;
        if (dist(this.player.x, this.player.y, c.x, c.y) < PLATE_REACH) weight++;
        for (const e of this.echoes.echoes) {
          if (!e.isSolid) continue;
          if (dist(e.x, e.y, c.x, c.y) < PLATE_REACH) {
            weight++;
            echoWeight++;
          }
        }
        const wasActive = p.active;
        p.weight = weight;
        p.active = weight > 0;
        if (p.active !== wasActive) {
          p.since = 0;
          // Announce the gate, not the plate. The gate is almost always outside
          // the fog radius, so this log line is the only cause-and-effect the
          // player gets.
          const s = this.plateStatus(p.id);
          if (s) {
            const full = s.held >= s.needed;
            this.pushLog(
              `${p.label} ${p.active ? "ENGAGED" : "RELEASED"} // ${s.label} ${s.held}/${s.needed}`,
              full ? "good" : "info",
            );
          }
        }
        if (p.active) this.platesHeld++;
        if (echoWeight > 0) this.platesHeldByEcho++;
        continue;
      }

      if (p.kind === "camera") {
        this.updateCamera(p, dt);
        continue;
      }

      if (p.kind === "exit") p.active = this.lockdown;
    }
  }

  private updateCamera(p: Prop, dt: number): void {
    const sweep = p.sweep ?? 0.7;
    const period = p.sweepPeriod ?? 6;
    p.aim = (p.facing ?? 0) + Math.sin((this.elapsed / period) * Math.PI * 2) * sweep;

    const c = tileCenter(p.tx, p.ty);
    // A browned-out zone takes its own cameras down with it.
    if (this.isSurged(this.level.zoneIdAt(p.tx, p.ty))) {
      p.alertT = Math.max(0, p.alertT - dt);
      return;
    }

    const cone: Cone = {
      x: c.x,
      y: c.y,
      facing: p.aim,
      halfAngle: 0.55,
      range: 7.5 * TILE,
      peripheral: 0,
    };

    // An unlit alcove defeats a fixed camera outright. MIMIC only takes a 0.3
    // visibility penalty in shadow because it is a hunter actively looking; a
    // wall-mounted lens has no such recourse. Without this the alcoves were a
    // trap — concealment that worked on the thing chasing you and not at all on
    // the thing that tells it where you are.
    const inShadow = this.level.at(toTileX(this.player.x), toTileY(this.player.y)) === Tile.Shadow;

    // Cameras never catch you; they hand your position to MIMIC, which is worse.
    if (!inShadow && coneVisibility(this.level, cone, this.player.x, this.player.y) > 0) {
      p.alertT = 1.4;
      this.mimic.alertTo(this.player.x, this.player.y, "world");
      this.adaptation.note("cameraExposure", 6, 5, `cam:${p.id}`);
      this.frameSightings.push({
        cameraId: p.id,
        x: this.player.x,
        y: this.player.y,
        target: "player",
        confidence: 0.95,
      });
      if (this.alarmCd <= 0) {
        this.alarmCd = 4;
        this.emitSound({
          x: c.x,
          y: c.y,
          loudness: SOUND.alarm,
          kind: "alarm",
          source: "world",
        });
        this.pushLog("CAMERA CONTACT // POSITION RELAYED", "warn");
        // A confirmed sighting on the facility's own cameras is grounds for an
        // escalation — but only once you are far enough in to have earned it.
        // The `"alarm"` reason existed and was never wired up.
        if (this.objectives.size >= 1) this.considerHunt("alarm");
      }
      return;
    }

    // A camera cannot tell a copy from the original. An ECHO walking a cone
    // produces a real report of something that is not you — which is exactly
    // how Camera Link gets turned against MIMIC.
    for (const e of this.echoes.echoes) {
      if (!e.isSolid) continue;
      if (this.level.at(toTileX(e.x), toTileY(e.y)) === Tile.Shadow) continue;
      if (coneVisibility(this.level, cone, e.x, e.y) <= 0) continue;
      p.alertT = 1.2;
      this.frameSightings.push({
        cameraId: p.id,
        x: e.x,
        y: e.y,
        target: "echo",
        // Familiarity is the only thing that erodes trust here.
        confidence: 0.8 * this.analysis.echoConfidence(e.rec.id, e.x, e.y, "camera"),
      });
      this.analysis.noteEchoPattern(e.rec.id, e.x, e.y, "camera", this.run);
      return;
    }

    p.alertT = Math.max(0, p.alertT - dt);
  }

  private updateDoors(dt: number): void {
    for (const d of this.level.doors) {
      // A security override beats every rule, but only while it lasts.
      if (d.lockedT > 0) {
        d.powered = false;
        const prev = d.openness;
        d.openness = damp(prev, 0, DOOR_RATE, dt);
        if (Math.abs(d.openness) < 0.01) d.openness = 0;
        d.justOpened = false;
        continue;
      }

      let powered = false;
      switch (d.rule.kind) {
        case "plates":
          powered = d.rule.plates.every((id) => this.level.propById.get(id)?.active === true);
          break;
        case "flags":
          powered = d.rule.flags.every((f) => this.objectives.has(f));
          break;
        case "signal":
          powered = this.puzzles.bus.evaluate(d.rule.expr);
          break;
        default: {
          const c = tileCenter(d.tx, d.ty);
          powered =
            dist(this.player.x, this.player.y, c.x, c.y) < HATCH_REACH ||
            dist(this.mimic.x, this.mimic.y, c.x, c.y) < HATCH_REACH ||
            this.echoes.echoes.some(
              (e) => e.isSolid && dist(e.x, e.y, c.x, c.y) < HATCH_REACH,
            );
          break;
        }
      }

      const target = powered ? 1 : 0;
      const prev = d.openness;
      d.powered = powered;
      d.openness = damp(prev, target, DOOR_RATE, dt);
      if (Math.abs(d.openness - target) < 0.01) d.openness = target;
      d.justOpened = prev < 0.9 && d.openness >= 0.9;

      if (d.justOpened) {
        const c = tileCenter(d.tx, d.ty);
        this.emitSound({
          x: c.x,
          y: c.y,
          loudness: SOUND.doorOpen,
          kind: "door",
          source: "world",
        });
      }
    }
  }

  /* ----------------------------------------------------------------- sound */

  private emitFootstep(
    x: number,
    y: number,
    sprinting: boolean,
    source: "player" | "echo",
    sneaking = false,
  ): void {
    const surface = footstepGain(this.level.at(toTileX(x), toTileY(y)));
    const loudness = footstepLoudness(sprinting, surface, sneaking);
    const kind: SoundKind = sprinting ? "sprint" : sneaking ? "sneak" : "step";
    this.emitSound({ x, y, loudness, kind, source });
    if (source === "player") {
      this.recorder.action({ kind: "sound", sound: kind, loudness, x, y });
    }
  }

  /**
   * MIMIC's footsteps.
   *
   * The single most valuable sound in the game. The player's light radius is
   * small, so for most of a run the only thing telling them where the hunter is
   * is what they can hear — and because these go through the same propagation
   * field as everything else, a wall between you turns the servo click into a
   * muffled thud. "It's on the other side of this wall" becomes a real thought.
   *
   * Emitted as source "mimic" so its own investigation logic and Deep Scan both
   * ignore them.
   */
  private emitMimicFootsteps(dt: number): void {
    // Silent by default. Emitting at all would still draw a sound ring and feed
    // the audio mix, so this returns before any of that rather than muting late.
    if (!this.settings.mimicFootsteps) return;
    const speed = Math.hypot(this.mimic.x - this.mimicLastX, this.mimic.y - this.mimicLastY) / dt;
    this.mimicLastX = this.mimic.x;
    this.mimicLastY = this.mimic.y;

    // Standing still is silent, which is what makes a stationary MIMIC scary.
    if (speed < 4) {
      this.mimicStepT = 0.12;
      return;
    }

    this.mimicStepT -= dt;
    if (this.mimicStepT > 0) return;
    // Faster movement, faster cadence — the rhythm alone tells you it is chasing.
    this.mimicStepT = clamp(26 / speed, 0.22, 0.62);

    this.emitSound({
      x: this.mimic.x,
      y: this.mimic.y,
      // Quieter than a sprint: it is heavy but unhurried, and it should not
      // drown the player's own noises out.
      loudness: this.mimic.alerted ? SOUND.footstepSprint * 0.8 : SOUND.footstepWalk * 1.35,
      kind: "mimicStep",
      source: "mimic",
    });
  }

  private emitSound(ev: SoundEvent): void {
    this.sounds.emit(this.level, ev);

    // Every noise leaves a trace Deep Scan can find later. Standing still leaves
    // nothing — which is the counterplay.
    //
    // MIMIC's own footsteps are excluded: Deep Scan hunts for disturbances the
    // *player* left, and letting it find its own would hand it a permanent
    // false trail leading exactly where it already is.
    if (ev.source !== "mimic") {
      this.traces.push({
        x: ev.x,
        y: ev.y,
        strength: clamp(ev.loudness / SOUND.alarm, 0.1, 1),
        source: ev.source,
        age: 0,
      });
      if (this.traces.length > 40) this.traces.shift();
    }

    if (ev.source === "echo" && ev.ownerId) {
      this.analysis.noteEchoPattern(ev.ownerId, ev.x, ev.y, ev.kind, this.run);
    } else if (ev.source === "player") {
      this.analysis.noteSound(ev.x, ev.y, ev.kind, this.run);
    }

    // What you hear and what MIMIC hears come from the same number — literally
    // the same propagation field, not a straight line. A door two rooms away
    // through solid wall is faint and muffled; the same door down an open
    // corridor is not, even at identical distance.
    const residual = this.sounds.residualAt(ev, this.level, this.player.x, this.player.y);
    const vol = clamp(residual / Math.max(0.001, ev.loudness), 0, 1);
    // Hand the renderer the same figure, so the ring you see matches what you hear.
    const ring = this.sounds.visible[this.sounds.visible.length - 1];
    if (ring) ring.audible = vol;
    const pan = clamp((ev.x - this.player.x) / (TILE * 12), -1, 1);
    // How much of the trip was spent getting through geometry rather than air.
    // Drives a low-pass, because occlusion dulls a sound as well as quieting it.
    const straight = dist(ev.x, ev.y, this.player.x, this.player.y) / TILE;
    const throughAir = clamp(1 - straight / Math.max(1, ev.loudness), 0, 1);
    const occlusion = clamp(throughAir - vol, 0, 1);
    this.sfx.play(ev.kind, vol * vol, pan, occlusion);
  }

  /* --------------------------------------------------------------- tactics */

  private detectTactics(
    dt: number,
    onShadow: boolean,
    divertedByEcho: boolean,
    ptx: number,
    pty: number,
  ): void {
    if (this.platesHeldByEcho > 0) {
      this.memory.noteStrategy("echo_hold");
      this.adaptation.note("echoDependency", 3, 6, "echo_hold");
    }
    if (this.platesHeld >= 2 && this.platesHeldByEcho >= 1) {
      this.memory.noteStrategy("echo_multi_hold");
    }

    // Route habit: credit the zone you are in, weighted by how worn it already
    // is. A corridor you always take teaches faster than one you rarely use.
    const zone = this.level.zoneIdAt(ptx, pty);
    if (zone) {
      const seen = this.memory.data.routeCounts[zone] ?? 0;
      if (seen >= 2) this.adaptation.note("routeDependency", 2 + Math.min(4, seen * 0.4), 4, `route:${zone}`);
    }

    // Doors teach it something when used to shake a pursuer — searching counts
    // as pursuit, not just an active chase.
    if (this.mimic.alerted || this.mimic.state === "investigate") {
      for (const d of this.level.doors) {
        if (d.openness < 0.9 || d.lockedT > 0) continue;
        const c = tileCenter(d.tx, d.ty);
        if (dist(this.player.x, this.player.y, c.x, c.y) < HATCH_REACH) {
          this.adaptation.note("doorDependency", 5, 5, `door:${d.id}`);
        }
      }
    }

    // Bait only counts when the diversion actually bought distance.
    if (
      divertedByEcho &&
      dist(this.player.x, this.player.y, this.mimic.x, this.mimic.y) > 8 * TILE
    ) {
      this.memory.noteStrategy("echo_bait");
      this.adaptation.note("echoDependency", 6, 5, "echo_bait");
    }

    // Any noise of yours that MIMIC actually hears teaches it your acoustic
    // habits — not just deliberate sprint-baiting, which almost never happened
    // in real play and left this counter permanently at zero.
    const heard = this.sounds.loudestAt(this.level, this.mimic.x, this.mimic.y);
    if (heard && heard.event.source === "player") {
      this.adaptation.note("noiseDependency", 4, 3, `noise:${heard.event.kind}`);
      if (heard.event.kind === "sprint") {
        this.memory.noteStrategy("sprint_lure");
        this.adaptation.note("noiseDependency", 3, 4, "sprint_lure");
      }
    }

    if (onShadow) {
      this.player.shadowT += dt;
      // Using concealment at all counts. Requiring MIMIC to already be searching
      // made this unreachable — the counter sat at zero through a whole run.
      if (this.player.shadowT > 1.2) {
        const spot = this.level.hideSpots.find(
          (h) => Math.abs(h.tx - ptx) <= 2 && Math.abs(h.ty - pty) <= 2,
        );
        if (spot) {
          this.memory.noteHide(spot.id);
          this.adaptation.note("hidingRepetition", 5, 6, `hide:${spot.id}`);
        } else {
          this.adaptation.note("hidingRepetition", 2, 6, "hide:shadow");
        }
        if (this.mimic.state === "investigate" || this.mimic.state === "alert") {
          this.memory.noteStrategy("shadow_wait");
        }
      }
    } else {
      this.player.shadowT = 0;
    }
  }

  /* --------------------------------------------------------- run lifecycle */

  /**
   * RETRACE is a temporal link, and MIMIC jams it once it has confirmed the
   * living player. Without this, a chase has no teeth: you could stand in the
   * open and press R as an emergency teleport. Jamming keys off direct sight of
   * the real you, never off MIMIC's state — so ECHO bait, sound diversions and
   * searches all leave the link intact.
   */
  get retraceJammed(): boolean {
    return this.mimic.playerDetected;
  }

  private handleRetraceHold(dt: number, input: Input | null): void {
    this.jamBuzz = Math.max(0, this.jamBuzz - dt * 2.2);
    this.jamNoticeCd = Math.max(0, this.jamNoticeCd - dt);

    const holding = Boolean(input?.isDown("KeyR"));

    if (this.retraceJammed) {
      // Any charge already banked is lost the moment the jam lands.
      this.retraceHold = 0;
      if (holding) {
        this.jamBuzz = 1;
        if (this.jamNoticeCd <= 0) {
          this.jamNoticeCd = 1.5;
          this.setNotice("RETRACE SIGNAL JAMMED", "warn", 1.1);
          this.sfx.play("jam", 0.5);
        }
      }
      return;
    }

    if (holding) {
      this.retraceHold += dt;
      if (this.retraceHold >= RETRACE_HOLD) {
        this.retraceHold = 0;
        this.doRetrace();
      }
    } else {
      this.retraceHold = 0;
    }
  }

  get retraceProgress(): number {
    return clamp(this.retraceHold / RETRACE_HOLD, 0, 1);
  }

  private doRetrace(): void {
    // A RETRACE taken under pressure is the one that teaches it something.
    if (this.mimic.alerted || this.mimic.detection > 0) {
      this.adaptation.note("retraceDependency", 9);
    }
    this.music.onRetrace();
    this.retraceFlash = 1;
    this.emitSound({
      x: this.player.x,
      y: this.player.y,
      loudness: SOUND.retrace,
      kind: "retrace",
      source: "player",
    });
    const banked = this.echoes.atCapacity;
    this.restart("retrace", { saveEcho: true });
    this.pushLog(banked ? "RETRACE // OLDEST ECHO DISSOLVED" : "RETRACE // ECHO RECORDED", "info");
  }

  private onCaught(): void {
    // Any RETRACE mid-charge dies with the capture — starting the hold at the
    // last possible moment must not buy an escape from the catch.
    this.retraceHold = 0;
    this.jamBuzz = 0;
    this.stability = Math.max(0, this.stability - 1);
    this.glitch = 1 - this.stability / STABILITY.max;
    this.glitchPulse = 1;
    this.shake = 1;
    this.sfx.play("impact", 0.9);
    this.music.onCatch();
    this.pushLog(this.strategist.current.taunt || "SUBJECT REACQUIRED", "warn");

    if (this.stability > 0) {
      this.phase = "caught";
      this.freezeT = STABILITY.catchFreeze;
    } else {
      this.phase = "collapse";
      this.freezeT = STABILITY.collapseFreeze;
      // The score collapses with the timeline: everything drops to silence,
      // then rebuilds from nothing once baseline is restored.
      this.music.onCollapse();
    }
  }

  private onEscaped(): void {
    this.phase = "escaped";
    this.freezeT = Infinity;
    const zone = this.level.zoneIdAt(toTileX(this.player.x), toTileY(this.player.y));
    this.memory.endRun("escape", [...this.objectives], this.runTime, zone);
    this.memory.save();
    this.pushLog("SURFACE LIFT ENGAGED // SUBJECT 047 CLEAR", "good");
  }

  private resolveFreeze(): void {
    if (this.phase === "caught") {
      // No ECHO from a capture — that is the cost, and the reason to press R.
      this.restart("caught", { saveEcho: false });
      return;
    }
    if (this.phase === "collapse") {
      this.restart("collapse", { saveEcho: false, wipeEchoes: true, decay: true });
      this.stability = STABILITY.max;
      this.glitch = 0;
      this.pushLog("TIMELINE FAILURE // RESTORING BASELINE", "warn");
      this.pushLog("IT STILL REMEMBERS", "warn");
    }
  }

  private restart(
    outcome: RunOutcome,
    opts: { saveEcho: boolean; wipeEchoes?: boolean; decay?: boolean },
  ): void {
    const zone = this.level.zoneIdAt(toTileX(this.player.x), toTileY(this.player.y));
    this.memory.endRun(outcome, [...this.objectives], this.runTime, zone);
    if (opts.decay) {
      this.memory.decayOnCollapse();
      // Collapse blurs the detail but never the shape, and never un-develops a
      // counter-measure. MIMIC remembers timelines the facility does not.
      this.adaptation.decay();
    }

    // Diegetic hint that something was learned — never what, never which tool.
    const surfaced = this.adaptation.takeSurfaced();
    if (surfaced.length > 0) {
      this.pushLog("BEHAVIOR ANALYSIS", "warn");
      for (const key of surfaced.slice(0, 2)) {
        this.pushLog(`${ADAPTATION_LABEL[key]}: IDENTIFIED`, "warn");
      }
    }

    if (opts.decay) this.music.onRestore();
    this.hunt.resetForRun();
    this.alert.reset();
    this.abilities.resetForRun();
    this.surges.clear();
    this.traces.length = 0;
    this.mimicFx.length = 0;
    for (const d of this.level.doors) d.lockedT = 0;
    this.memory.data.adaptation = { ...this.adaptation.values };
    this.memory.data.abilities = this.abilities.unlockedIds();

    if (opts.saveEcho) {
      const rec = this.recorder.finish(this.run);
      if (rec) this.echoes.add(rec);
    }
    if (opts.wipeEchoes) this.echoes.clear();

    this.recorder.reset();
    this.echoes.rewindAll();
    this.run++;
    this.runTime = 0;
    this.retraceHold = 0;

    this.resetTransientWorld();
    this.player.reset(this.level.playerSpawn.x, this.level.playerSpawn.y);
    this.mimic.reset(this.level.mimicSpawn.x, this.level.mimicSpawn.y);
    this.sounds.clear();
    this.fog.lit.fill(0);

    // Local plan now; Claude's plan swaps in mid-run if it arrives.
    this.strategist.plan(this.memory, this.strategyContext());
    this.applyStrategy();
    this.memory.save();
    this.phase = "playing";
  }

  /** Everything that is not permanent progress goes back to its start state. */
  private resetTransientWorld(): void {
    // Every timer, latch and signal in the wing drops at once. A puzzle cannot
    // carry half-solved state into the next attempt, and no surviving signal
    // combination can leave a door sealed on a run that has to get past it.
    this.puzzles.reset();
    for (const p of this.level.props) {
      p.weight = 0;
      p.alertT = 0;
      p.since = 999;
      p.aim = p.facing ?? 0;
      p.active = p.objective ? this.objectives.has(p.objective) : false;
    }
    for (const d of this.level.doors) {
      d.openness = 0;
      d.powered = false;
      d.justOpened = false;
    }
  }

  /* ------------------------------------------------------------------- HUD */

  /** Short centred flash. Replaces any notice still on screen. */
  private setNotice(text: string, tone: LogTone, seconds = 1.8): void {
    this.notice = { text, t: seconds, tone };
  }

  pushLog(text: string, tone: LogTone = "info"): void {
    const last = this.log[this.log.length - 1];
    if (last && last.text === text && last.age < 1) return;
    this.log.push({ text, tone, age: 0 });
    if (this.log.length > 6) this.log.shift();
  }

  /* ----------------------------------------------------------------- story */

  /**
   * The world as the narrative layer is allowed to see it.
   *
   * Read-only facts in, presentation hooks out. The story cannot move the
   * player, open a door or change an objective by reaching into the simulation —
   * everything it is permitted to do is on this interface, which is what keeps
   * a reveal from ever breaking a run.
   */
  private storyContext(dt: number): StoryContext {
    return {
      dt,
      elapsed: this.elapsed,
      player: { x: this.player.x, y: this.player.y },
      knowledge: this.memory.knowledge(),
      mimicDetecting: this.mimic.playerDetected,
      echoCount: this.echoes.count,
      objectives: this.objectives,
      collapses: this.memory.data.collapses,
      huntActive: this.hunt.active,
      // Routed to the story banner, never the centre notice: two different
      // widgets showing the same sentence reads as a bug, because it is one.
      announce: (text, seconds, tone) => this.story.say(text, seconds, tone),
      log: (text) => this.pushLog(text, "info"),
      mimicSays: (text) => this.pushLog(`MIMIC // ${text}`, "warn"),
      spawnOldEcho: (def) => this.spawnOldEcho(def),
      focusCamera: (x, y, seconds) => this.story.requestFocus(x, y, seconds),
      glitch: (strength) => {
        this.glitchPulse = Math.max(this.glitchPulse, strength);
      },
      play: (kind, volume) => this.sfx.play(kind as SoundKind, volume),
    };
  }

  /**
   * Puts an ECHO in the room that the player never recorded.
   *
   * It goes through `echoes.add` like any other, so it walks, animates and
   * dissolves on exactly the same code path. Nothing about it is special except
   * where the recording came from — which is the only thing that matters.
   */
  private spawnOldEcho(def: OldEchoDef): void {
    // Ephemeral: outside the three-slot budget, so a story beat can never cost
    // the player an ECHO they spent a run recording.
    this.echoes.add(buildOldEcho(def, this.run), true);
    this.sfx.play("retrace", 0.35);
  }

  /** Opens a story terminal, resolving any generated page against live data. */
  private openStoryTerminal(propId: string): boolean {
    const def = this.story.terminalFor(propId);
    if (!def) return false;
    const page = def.pages[0];
    const src = {
      memory: this.memory,
      adaptation: this.adaptation,
      level: this.level,
      run: this.run,
      collapses: this.memory.data.collapses,
    };
    let lines = page.lines;
    if (page.generated === "behaviour") lines = behaviourLines(src);
    else if (page.generated === "trials") lines = trialLines(src, false);
    else if (page.generated === "restorations") lines = restorationLines(src);

    this.story.openTerminal(def, page.title, lines);
    this.sfx.play("interact", 0.5);
    return true;
  }

  /** Live text for the open terminal, so the trial glitch can swap mid-read. */
  terminalLines(): string[] {
    const t = this.story.terminal;
    if (!t) return [];
    if (t.def.trialGlitch && this.story.trialGlitchActive) {
      return trialLines(
        {
          memory: this.memory,
          adaptation: this.adaptation,
          level: this.level,
          run: this.run,
          collapses: this.memory.data.collapses,
        },
        true,
      );
    }
    return t.lines;
  }

  /** Per-component puzzle state, for the F1 overlay. */
  puzzleDebugLines(): string[] {
    return this.puzzles.debugLines(this.puzzleContext(0));
  }

  /** True while MIMIC is close enough to matter but not visible on screen. */
  mimicProximity(): number {
    const d = dist(this.player.x, this.player.y, this.mimic.x, this.mimic.y);
    const range = MIMIC_TUNING.visionTiles * TILE * 2;
    return clamp(1 - d / range, 0, 1);
  }
}
