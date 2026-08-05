/**
 * ECHOs.
 *
 * Every run is recorded frame-exactly at the fixed simulation rate: position,
 * facing, movement mode, plus a timestamped list of the discrete things you did
 * (interactions and the noises you made). Pressing RETRACE ends the run, turns
 * the recording into an ECHO, and restarts every existing ECHO from t=0 so all
 * timelines stay aligned against the same run clock. That alignment is what
 * makes multi-ECHO puzzles work: three ECHOs converging on three plates are
 * three past runs replaying in lockstep with your current one.
 *
 * A FIFO of three is the hard cap from the design brief — recording a fourth
 * dissolves the oldest.
 *
 * Once a recording runs out, the ECHO does not vanish; it settles into
 * "residue" and holds its final pose. Without that, a plate held at the end of
 * a run would pop back up the instant the recording ended and the 2- and
 * 3-plate gates would be unsolvable.
 */
import { ECHO, TICK_RATE } from "../core/constants";
import type { Dir } from "../core/math";
import type { SoundKind } from "./sound";

const MAX_FRAMES = Math.ceil(ECHO.maxRunSeconds * TICK_RATE);

const FLAG_MOVING = 1;
const FLAG_SPRINT = 2;
const DIR_SHIFT = 2;
/** Bit 5, above the three direction bits. */
const FLAG_SNEAK = 32;
/** Three bits — eight facings. A two-bit mask silently truncated diagonals. */
const DIR_MASK = 7;

export type EchoAction =
  | { tick: number; kind: "sound"; sound: SoundKind; loudness: number; x: number; y: number }
  | { tick: number; kind: "interact"; propId: string; x: number; y: number };

/**
 * A plain `Omit` over a union keeps only the keys common to every member, which
 * would silently drop `sound` and `propId`. Distribute so each variant keeps its
 * own payload.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EchoActionInput = DistributiveOmit<EchoAction, "tick">;

export interface EchoRecording {
  id: string;
  /** Simulation ticks captured. */
  length: number;
  xs: Float32Array;
  ys: Float32Array;
  flags: Uint8Array;
  actions: EchoAction[];
  /** Which run index produced this recording — used for HUD labelling. */
  run: number;
}

export interface PoseSample {
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  sprinting: boolean;
  sneaking: boolean;
}

export function poseAt(rec: EchoRecording, tick: number): PoseSample {
  const i = Math.max(0, Math.min(rec.length - 1, tick));
  const f = rec.flags[i];
  return {
    x: rec.xs[i],
    y: rec.ys[i],
    dir: ((f >> DIR_SHIFT) & DIR_MASK) as Dir,
    moving: (f & FLAG_MOVING) !== 0,
    sprinting: (f & FLAG_SPRINT) !== 0,
    sneaking: (f & FLAG_SNEAK) !== 0,
  };
}

/** Captures the live player's run so it can be replayed as an ECHO. */
export class Recorder {
  private xs = new Float32Array(MAX_FRAMES);
  private ys = new Float32Array(MAX_FRAMES);
  private flags = new Uint8Array(MAX_FRAMES);
  private actions: EchoAction[] = [];
  private count = 0;
  private nextId = 1;

  get frameCount(): number {
    return this.count;
  }

  get seconds(): number {
    return this.count / TICK_RATE;
  }

  get full(): boolean {
    return this.count >= MAX_FRAMES;
  }

  reset(): void {
    this.count = 0;
    this.actions = [];
  }

  sample(
    x: number,
    y: number,
    dir: Dir,
    moving: boolean,
    sprinting: boolean,
    sneaking = false,
  ): void {
    if (this.count >= MAX_FRAMES) return;
    const i = this.count++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.flags[i] =
      (moving ? FLAG_MOVING : 0) |
      (sprinting ? FLAG_SPRINT : 0) |
      (sneaking ? FLAG_SNEAK : 0) |
      (dir << DIR_SHIFT);
  }

  /** Records a discrete event at the frame currently being captured. */
  action(a: EchoActionInput): void {
    if (this.count >= MAX_FRAMES) return;
    this.actions.push({ ...a, tick: Math.max(0, this.count - 1) } as EchoAction);
  }

  /** Freeze the run into an immutable recording. Returns null if nothing useful. */
  finish(run: number): EchoRecording | null {
    if (this.count < 2) return null;
    return {
      id: `echo-${this.nextId++}`,
      length: this.count,
      xs: this.xs.slice(0, this.count),
      ys: this.ys.slice(0, this.count),
      flags: this.flags.slice(0, this.count),
      actions: this.actions.slice(),
      run,
    };
  }
}

export type EchoPhase = "replay" | "residue" | "disrupted";

/** A live playback of one past run. */
export class Echo {
  x = 0;
  y = 0;
  dir: Dir = 0;
  moving = false;
  sprinting = false;
  /** Replayed so a past self creeps exactly as quietly as you did. */
  sneaking = false;
  /** Ticks elapsed in the current run. */
  tick = 0;
  phase: EchoPhase = "replay";
  disruptT = 0;
  /** Index of the next action to fire; reset whenever the timeline restarts. */
  private actionCursor = 0;
  /** Set for one tick each time the echo re-performs an interaction. */
  firedInteractions: string[] = [];
  /** Set for one tick each time the echo re-emits a noise. */
  firedSounds: { sound: SoundKind; loudness: number; x: number; y: number }[] = [];
  /** Visual jitter seed so multiple echoes do not flicker in sync. */
  readonly seed: number;

  constructor(readonly rec: EchoRecording) {
    this.seed = (rec.run * 2654435761) % 1000;
    this.rewind();
  }

  /** True for story apparitions: outside the ECHO budget, self-removing. */
  ephemeral = false;

  get isSolid(): boolean {
    return this.phase !== "disrupted";
  }

  get progress(): number {
    return Math.min(1, this.tick / Math.max(1, this.rec.length));
  }

  rewind(): void {
    this.tick = 0;
    this.actionCursor = 0;
    this.phase = "replay";
    this.disruptT = 0;
    const p = poseAt(this.rec, 0);
    this.x = p.x;
    this.y = p.y;
    this.dir = p.dir;
    this.moving = p.moving;
    this.sprinting = p.sprinting;
    this.sneaking = p.sneaking;
  }

  /** MIMIC touched it: dissolve for a while, then rejoin its timeline. */
  disrupt(): void {
    if (this.phase === "disrupted") return;
    this.phase = "disrupted";
    this.disruptT = ECHO.disruptSeconds;
  }

  advance(dt: number): void {
    this.firedInteractions.length = 0;
    this.firedSounds.length = 0;

    if (this.phase === "disrupted") {
      this.disruptT -= dt;
      // The timeline keeps running while it is dissolved — it does not get to
      // pause and catch up later.
      this.tick++;
      this.syncPose();
      if (this.disruptT <= 0) {
        this.phase = this.tick >= this.rec.length ? "residue" : "replay";
      }
      return;
    }

    if (this.tick < this.rec.length) {
      // Fire everything scheduled for this tick before advancing past it.
      while (
        this.actionCursor < this.rec.actions.length &&
        this.rec.actions[this.actionCursor].tick <= this.tick
      ) {
        const a = this.rec.actions[this.actionCursor++];
        if (a.kind === "interact") this.firedInteractions.push(a.propId);
        else
          this.firedSounds.push({
            sound: a.sound,
            loudness: a.loudness,
            x: a.x,
            y: a.y,
          });
      }
      this.tick++;
      this.syncPose();
      if (this.tick >= this.rec.length) this.phase = "residue";
    } else {
      this.phase = "residue";
    }
  }

  private syncPose(): void {
    const p = poseAt(this.rec, Math.min(this.tick, this.rec.length - 1));
    this.x = p.x;
    this.y = p.y;
    this.dir = p.dir;
    this.moving = this.tick < this.rec.length ? p.moving : false;
    this.sprinting = this.tick < this.rec.length ? p.sprinting : false;
    this.sneaking = this.tick < this.rec.length ? p.sneaking : false;
  }
}

/** FIFO of live ECHOs, capped at the design limit. */
export class EchoManager {
  readonly echoes: Echo[] = [];
  /** Ids evicted this tick, so the presentation layer can play a dissolve. */
  readonly evicted: { id: string; x: number; y: number }[] = [];

  get count(): number {
    return this.echoes.filter((e) => !e.ephemeral).length;
  }

  get atCapacity(): boolean {
    return this.count >= ECHO.maxActive;
  }

  /**
   * Banks a recording.
   *
   * `ephemeral` marks an ECHO the player did not create — a story apparition.
   * Those sit outside the three-slot budget entirely: they neither evict a
   * recording nor occupy a slot, because a narrative beat that destroyed the
   * ECHO you spent three runs setting up would be indefensible. They also clean
   * themselves up once their recording ends, so an apparition appears, does its
   * one thing, and is gone.
   */
  add(rec: EchoRecording, ephemeral = false): Echo {
    const echo = new Echo(rec);
    echo.ephemeral = ephemeral;
    this.echoes.push(echo);
    if (!ephemeral) {
      while (this.echoes.filter((e) => !e.ephemeral).length > ECHO.maxActive) {
        const idx = this.echoes.findIndex((e) => !e.ephemeral);
        const old = this.echoes.splice(idx, 1)[0];
        this.evicted.push({ id: old.rec.id, x: old.x, y: old.y });
      }
    }
    return echo;
  }

  /** Drops finished apparitions. Called once the tick's readers are done. */
  private sweepEphemeral(): void {
    for (let i = this.echoes.length - 1; i >= 0; i--) {
      const e = this.echoes[i];
      if (e.ephemeral && e.phase !== "replay") this.echoes.splice(i, 1);
    }
  }

  /** Restart every timeline — called whenever a new run begins. */
  rewindAll(): void {
    for (const e of this.echoes) e.rewind();
  }

  advanceAll(dt: number): void {
    for (const e of this.echoes) e.advance(dt);
  }

  clear(): void {
    this.echoes.length = 0;
    this.evicted.length = 0;
  }

  endTick(): void {
    this.evicted.length = 0;
    // Swept here, after everything that reads the list has had its look, so an
    // apparition is never removed out from under a renderer mid-frame.
    this.sweepEphemeral();
  }
}
