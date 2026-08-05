/**
 * Reusable puzzle components.
 *
 * Each one is a small, self-contained thing that reads the world and raises
 * signals. None of them knows what it controls, and none of them contains
 * puzzle-specific logic — a "four simultaneous bodies" scanner is the same class
 * whether it gates a door, a terminal, or the finale.
 *
 * The design rule that matters: a component must be satisfiable by an ECHO, not
 * just by the living player. Everything here that counts bodies counts solid
 * ECHOs too, and everything that listens for noise hears the noise an ECHO
 * reproduces. That is what makes these puzzles RETRACE puzzles rather than
 * ordinary switch puzzles wearing a sci-fi hat.
 */
import { TILE } from "../core/constants";
import type { Rect } from "../world/level";
import type { SignalExpr } from "./signals";
import type { SignalBus } from "./signals";
import type { SoundKind, SoundSource } from "../systems/sound";
import type { LogTone } from "../game/game";
import type { ObjectiveId } from "../core/constants";

export interface PuzzleBody {
  x: number;
  y: number;
  /** ECHOs count for almost everything. That is the point of the game. */
  kind: "player" | "echo";
  id: string;
}

export interface HeardSound {
  loudness: number;
  kind: SoundKind;
  source: SoundSource;
}

export interface PuzzleContext {
  dt: number;
  elapsed: number;
  bus: SignalBus;
  /** The living player plus every solid ECHO. */
  bodies: PuzzleBody[];
  mimic: { x: number; y: number; state: string; alerted: boolean };
  /**
   * Loudest thing audible at a world point this tick, optionally restricted to
   * certain kinds. The filter has to happen inside the lookup: a sensor that
   * only answers to impulses cannot ask for the loudest sound and then check its
   * kind, or a louder footstep on the same tick masks the dash it wanted.
   */
  heardAt(x: number, y: number, kinds?: readonly SoundKind[] | null): HeardSound | null;
  /** What a named camera reported this tick, if anything. */
  cameraSaw(cameraId: string): "player" | "echo" | null;
  /** True while MIMIC has spent an ability and cannot use it again yet. */
  abilityOnCooldown(abilityId: string): boolean;
  /** Whether a named prop is latched on. */
  propActive(propId: string): boolean;
  log(text: string, tone?: LogTone): void;
  notice(text: string, tone: LogTone, seconds?: number): void;
  play(kind: SoundKind, volume: number): void;
}

/** Everything a component must be able to do. */
export interface PuzzleComponent {
  readonly id: string;
  /** Signal ids this component can raise, for the debug overlay and schematic. */
  readonly emits: string[];
  /** Short human label, used by readouts and the schematic. */
  readonly label: string;
  update(ctx: PuzzleContext): void;
  /** Called on RETRACE, catch and collapse. Must leave no state behind. */
  reset(): void;
  /** One line of live state for the debug overlay. */
  status(ctx: PuzzleContext): string;
}

const centreOf = (r: Rect): { x: number; y: number } => ({
  x: (r.x + r.w / 2) * TILE,
  y: (r.y + r.h / 2) * TILE,
});

const inRect = (r: Rect, x: number, y: number): boolean => {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
};

/* -------------------------------------------------------------- scanner pad */

export interface ScannerDef {
  kind: "scanner";
  id: string;
  emits: string;
  label: string;
  area: Rect;
  /** Bodies required inside. One is a footplate; four is the finale. */
  need?: number;
  /** Refuse to count the living player, forcing the pad onto an ECHO. */
  echoOnly?: boolean;
}

/**
 * A floor pad that reads temporal signatures. Counts any body standing in it,
 * living or recorded — which is exactly the thing the facility was never built
 * to expect, and the reason four of these at once reads as an anomaly.
 */
export class Scanner implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly area: Rect;
  readonly need: number;
  private readonly echoOnly: boolean;
  private readonly signal: string;
  /** Bodies present this tick, exposed for readouts. */
  count = 0;

  constructor(def: ScannerDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.area = def.area;
    this.need = def.need ?? 1;
    this.echoOnly = def.echoOnly ?? false;
  }

  update(ctx: PuzzleContext): void {
    let n = 0;
    for (const b of ctx.bodies) {
      if (this.echoOnly && b.kind === "player") continue;
      if (inRect(this.area, b.x, b.y)) n++;
    }
    this.count = n;
    if (n >= this.need) ctx.bus.raise(this.signal, 1);
    else if (n > 0) ctx.bus.raise(`${this.signal}.partial`, n / this.need);
  }

  reset(): void {
    this.count = 0;
  }

  status(): string {
    return `${this.count}/${this.need}`;
  }

  centre(): { x: number; y: number } {
    return centreOf(this.area);
  }
}

/* ------------------------------------------------------------ timed switch */

export interface TimedSwitchDef {
  kind: "timed";
  id: string;
  emits: string;
  label: string;
  /** The interactable prop that arms it. */
  propId: string;
  /** How long the signal stays up after activation. */
  seconds: number;
}

/**
 * A switch that holds its output for a while and then drops it. This is the
 * component that turns "press two things" into "press two things *together*",
 * and the window is deliberately generous — the brief is explicit that nothing
 * here may demand frame-perfect timing.
 */
export class TimedSwitch implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly propId: string;
  readonly seconds: number;
  private t = 0;
  private wasActive = false;
  private readonly signal: string;

  constructor(def: TimedSwitchDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.propId = def.propId;
    this.seconds = def.seconds;
  }

  update(ctx: PuzzleContext): void {
    const on = ctx.propActive(this.propId);
    // Re-arms on the rising edge, so an ECHO re-performing the interaction
    // restarts the window exactly as the living player would.
    if (on && !this.wasActive) {
      this.t = this.seconds;
      ctx.play("link", 0.5);
    }
    this.wasActive = on;

    if (this.t > 0) {
      this.t = Math.max(0, this.t - ctx.dt);
      ctx.bus.raise(this.signal, 1);
    }
  }

  /** Seconds of window left, for the readout. */
  get remaining(): number {
    return this.t;
  }

  reset(): void {
    this.t = 0;
    this.wasActive = false;
  }

  status(): string {
    return this.t > 0 ? `${this.t.toFixed(1)}s` : "idle";
  }
}

/* ------------------------------------------------------------ sound sensor */

export interface SoundSensorDef {
  kind: "sound";
  id: string;
  emits: string;
  label: string;
  tx: number;
  ty: number;
  /** Residual loudness required to trip it. */
  threshold?: number;
  /** How long the signal stays up after a trip. */
  holdSeconds?: number;
  /** Only trip on these kinds — a dash-only sensor, say. */
  accepts?: SoundKind[];
}

/**
 * A microphone. It does not care who made the noise, which is the entire trick:
 * an ECHO's recorded footsteps and dashes are real sound events in the world,
 * so a sensor three rooms from the living player can be satisfied by something
 * you did two runs ago.
 */
export class SoundSensor implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly tx: number;
  readonly ty: number;
  private readonly signal: string;
  private readonly threshold: number;
  private readonly hold: number;
  private readonly accepts: SoundKind[] | null;
  private t = 0;
  /** What last tripped it, for the readout. */
  lastKind: SoundKind | null = null;

  constructor(def: SoundSensorDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.tx = def.tx;
    this.ty = def.ty;
    this.threshold = def.threshold ?? 1.2;
    this.hold = def.holdSeconds ?? 3.5;
    this.accepts = def.accepts ?? null;
  }

  update(ctx: PuzzleContext): void {
    const heard = ctx.heardAt(
      this.tx * TILE + TILE / 2,
      this.ty * TILE + TILE / 2,
      this.accepts,
    );
    if (heard && heard.loudness >= this.threshold) {
      if (this.t <= 0) ctx.play("link", 0.45);
      this.t = this.hold;
      this.lastKind = heard.kind;
    }
    if (this.t > 0) {
      this.t = Math.max(0, this.t - ctx.dt);
      ctx.bus.raise(this.signal, 1);
    }
  }

  get remaining(): number {
    return this.t;
  }

  reset(): void {
    this.t = 0;
    this.lastKind = null;
  }

  status(): string {
    return this.t > 0 ? `${this.lastKind ?? "?"} ${this.t.toFixed(1)}s` : "quiet";
  }
}

/* -------------------------------------------------------------- camera tap */

export interface CameraTapDef {
  kind: "cameraTap";
  id: string;
  emits: string;
  label: string;
  cameraId: string;
  /**
   * Whose sighting counts. `echo` is the interesting one: the facility relays a
   * contact it believes is Subject 047, and that false report is the resource.
   */
  target?: "player" | "echo" | "any";
  holdSeconds?: number;
}

/**
 * Taps a security camera's report line. Turns surveillance into something the
 * player can spend: let a copy of yourself be seen somewhere harmless, and the
 * facility's own certainty about where you are becomes a key.
 */
export class CameraTap implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly cameraId: string;
  private readonly signal: string;
  private readonly target: "player" | "echo" | "any";
  private readonly hold: number;
  private t = 0;

  constructor(def: CameraTapDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.cameraId = def.cameraId;
    this.target = def.target ?? "echo";
    this.hold = def.holdSeconds ?? 6;
  }

  update(ctx: PuzzleContext): void {
    const saw = ctx.cameraSaw(this.cameraId);
    if (saw && (this.target === "any" || saw === this.target)) {
      if (this.t <= 0) ctx.log(`CONTACT RELAYED // ${this.label}`, "warn");
      this.t = this.hold;
    }
    if (this.t > 0) {
      this.t = Math.max(0, this.t - ctx.dt);
      ctx.bus.raise(this.signal, 1);
    }
  }

  get remaining(): number {
    return this.t;
  }

  reset(): void {
    this.t = 0;
  }

  status(): string {
    return this.t > 0 ? `relaying ${this.t.toFixed(1)}s` : "clear";
  }
}

/* ------------------------------------------------------------ MIMIC scanner */

export interface MimicScannerDef {
  kind: "mimicScanner";
  id: string;
  emits: string;
  label: string;
  area: Rect;
  /** How long the authorisation persists after MIMIC leaves the arch. */
  holdSeconds?: number;
}

/**
 * A security arch that reads a containment-grade signature. The player does not
 * have one and never will — the only thing in the facility that does is the
 * thing hunting them, so the door opens by getting MIMIC to walk through it.
 *
 * This is the component that reframes MIMIC from obstacle to instrument.
 */
export class MimicScanner implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly area: Rect;
  private readonly signal: string;
  private readonly hold: number;
  private t = 0;
  /** True while MIMIC is physically inside the arch. */
  present = false;

  constructor(def: MimicScannerDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.area = def.area;
    this.hold = def.holdSeconds ?? 14;
  }

  update(ctx: PuzzleContext): void {
    this.present = inRect(this.area, ctx.mimic.x, ctx.mimic.y);
    if (this.present) {
      if (this.t <= 0) {
        ctx.notice("CONTAINMENT SIGNATURE ACCEPTED", "good", 2.2);
        ctx.log(`${this.label} // AUTHORIZATION GRANTED`, "good");
        ctx.play("override", 0.6);
      }
      this.t = this.hold;
    }
    if (this.t > 0) {
      this.t = Math.max(0, this.t - ctx.dt);
      ctx.bus.raise(this.signal, 1);
    }
  }

  get remaining(): number {
    return this.t;
  }

  reset(): void {
    this.t = 0;
    this.present = false;
  }

  status(): string {
    return this.present ? "MIMIC INSIDE" : this.t > 0 ? `auth ${this.t.toFixed(1)}s` : "empty";
  }

  centre(): { x: number; y: number } {
    return centreOf(this.area);
  }
}

/* ----------------------------------------------------- spent-ability window */

export interface AbilityWindowDef {
  kind: "abilityWindow";
  id: string;
  emits: string;
  label: string;
  /** The MIMIC ability whose cooldown opens the window. */
  abilityId: string;
}

/**
 * Raised while MIMIC cannot afford a particular counter-measure. Baiting it into
 * spending Door Control on a route you were never going to take is the puzzle;
 * this component is what makes the resulting cooldown into a door you can walk
 * through.
 */
export class AbilityWindow implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly abilityId: string;
  private readonly signal: string;
  private wasOpen = false;

  constructor(def: AbilityWindowDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.abilityId = def.abilityId;
  }

  update(ctx: PuzzleContext): void {
    const open = ctx.abilityOnCooldown(this.abilityId);
    if (open) ctx.bus.raise(this.signal, 1);
    if (open && !this.wasOpen) {
      ctx.log(`${this.label} // OVERRIDE BUFFER DEPLETED`, "good");
      ctx.play("link", 0.5);
    }
    this.wasOpen = open;
  }

  reset(): void {
    this.wasOpen = false;
  }

  status(ctx: PuzzleContext): string {
    return ctx.abilityOnCooldown(this.abilityId) ? "OPEN" : "closed";
  }
}

/* ------------------------------------------------------------------- latch */

export interface LatchDef {
  kind: "latch";
  id: string;
  emits: string;
  label: string;
  /** Condition that trips the latch. */
  when: SignalExpr;
  /** Announced once, the moment it trips. */
  announce?: string;
  /** Held for the rest of the run once tripped, rather than needing to be held. */
  holdForRun?: boolean;
  /**
   * Survives RETRACE, like a facility door that stays unsealed once cleared.
   *
   * Off by default — puzzle state resetting cleanly is what stops a half-solved
   * attempt leaking into the next one. It is on only where re-solving would be
   * busywork rather than a puzzle: the containment arch, whose challenge is
   * getting MIMIC to walk through it once, not doing so again on every single
   * run needed to set up the bay behind it.
   */
  persistAcrossRuns?: boolean;
  /**
   * Facility system this latch brings online. Solving the puzzle completes the
   * objective permanently, exactly as flipping a reactor interlock does — so the
   * puzzle is a stage of the campaign rather than optional side content, and it
   * never has to be re-solved after a catch.
   */
  completes?: ObjectiveId;
}

/**
 * Remembers that a condition was met. Multi-body puzzles need this: getting four
 * signatures onto four pads at the same instant is the achievement, and the door
 * must not slam the moment one ECHO walks off its pad.
 *
 * Latches clear on RETRACE like everything else, so nothing here can be banked
 * permanently by accident.
 */
export class Latch implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly when: SignalExpr;
  /** Facility system this latch brings online, if any. */
  readonly completes: ObjectiveId | null;
  private readonly signal: string;
  private readonly announce: string | null;
  private readonly holdForRun: boolean;
  private readonly persists: boolean;
  private latched = false;

  constructor(def: LatchDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.when = def.when;
    this.announce = def.announce ?? null;
    this.holdForRun = def.holdForRun ?? true;
    this.persists = def.persistAcrossRuns ?? false;
    this.completes = def.completes ?? null;
  }

  get isLatched(): boolean {
    return this.latched;
  }

  update(ctx: PuzzleContext): void {
    if (!this.latched && ctx.bus.evaluate(this.when)) {
      this.latched = true;
      if (this.announce) {
        ctx.notice(this.announce, "good", 2.6);
        ctx.log(this.announce, "good");
      }
      ctx.play("override", 0.7);
    }
    if (this.latched && this.holdForRun) ctx.bus.raise(this.signal, 1);
  }

  reset(): void {
    if (!this.persists) this.latched = false;
  }

  status(): string {
    return this.latched ? "LATCHED" : "open";
  }
}

/* ---------------------------------------------------------------- sequence */

export interface SequenceDef {
  kind: "sequence";
  id: string;
  emits: string;
  label: string;
  /** Signals that must go high in this order. */
  steps: SignalExpr[];
  /** Time allowed between consecutive steps before the sequence resets. */
  windowSeconds?: number;
}

/**
 * Steps that must happen in order, each within a window of the last. Out-of-order
 * activation resets rather than failing outright, so experimenting is cheap —
 * the brief is explicit that a wrong guess should teach, not punish.
 */
export class Sequence implements PuzzleComponent {
  readonly id: string;
  readonly emits: string[];
  readonly label: string;
  readonly steps: SignalExpr[];
  private readonly signal: string;
  private readonly window: number;
  private at = 0;
  private t = 0;

  constructor(def: SequenceDef) {
    this.id = def.id;
    this.signal = def.emits;
    this.emits = [def.emits];
    this.label = def.label;
    this.steps = def.steps;
    this.window = def.windowSeconds ?? 12;
  }

  /** How far through the order it is, for the readout. */
  get progress(): number {
    return this.at;
  }

  update(ctx: PuzzleContext): void {
    if (this.at >= this.steps.length) {
      ctx.bus.raise(this.signal, 1);
      return;
    }

    if (this.at > 0) {
      this.t -= ctx.dt;
      if (this.t <= 0) {
        this.at = 0;
        ctx.log(`${this.label} // SEQUENCE TIMED OUT`, "warn");
      }
    }

    if (ctx.bus.evaluate(this.steps[this.at])) {
      this.at++;
      this.t = this.window;
      if (this.at >= this.steps.length) {
        ctx.log(`${this.label} // SEQUENCE COMPLETE`, "good");
        ctx.bus.raise(this.signal, 1);
      } else {
        ctx.log(`${this.label} // STAGE ${this.at}/${this.steps.length}`, "info");
        ctx.play("link", 0.5);
      }
    }
  }

  reset(): void {
    this.at = 0;
    this.t = 0;
  }

  status(): string {
    return `${this.at}/${this.steps.length}${this.at > 0 && this.at < this.steps.length ? ` ${this.t.toFixed(1)}s` : ""}`;
  }
}

export type ComponentDef =
  | ScannerDef
  | TimedSwitchDef
  | SoundSensorDef
  | CameraTapDef
  | MimicScannerDef
  | AbilityWindowDef
  | LatchDef
  | SequenceDef;

export function makeComponent(def: ComponentDef): PuzzleComponent {
  switch (def.kind) {
    case "scanner":
      return new Scanner(def);
    case "timed":
      return new TimedSwitch(def);
    case "sound":
      return new SoundSensor(def);
    case "cameraTap":
      return new CameraTap(def);
    case "mimicScanner":
      return new MimicScanner(def);
    case "abilityWindow":
      return new AbilityWindow(def);
    case "latch":
      return new Latch(def);
    case "sequence":
      return new Sequence(def);
  }
}
