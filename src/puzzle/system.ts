/**
 * Owns every puzzle component in a level and runs them once per tick.
 *
 * Ordering matters and is fixed here: props resolve first (so a plate knows its
 * weight), then components read the world and raise signals, then doors evaluate
 * their expressions against the bus. Anything that reads a signal in the same
 * tick it was raised therefore sees it — no one-tick lag between standing on a
 * pad and the door acknowledging it.
 */
import type { Rect } from "../world/level";
import {
  type ComponentDef,
  type PuzzleComponent,
  type PuzzleContext,
  Latch,
  MimicScanner,
  Scanner,
  SoundSensor,
  makeComponent,
} from "./components";
import { type SignalExpr, SignalBus, describeExpr } from "./signals";

export interface PuzzleDef {
  id: string;
  /** Room-facing name, used in logs and the schematic. */
  label: string;
  components: ComponentDef[];
  /**
   * One line explaining what this puzzle wants, shown when the player is inside
   * its bounds. The brief is explicit: make the rules legible, do not solve it.
   */
  brief?: string;
  /** Where the brief applies. */
  bounds?: Rect;
}

export class PuzzleSystem {
  readonly bus = new SignalBus();
  readonly components: PuzzleComponent[] = [];
  readonly puzzles: PuzzleDef[] = [];
  private readonly byPuzzle = new Map<string, PuzzleComponent[]>();
  private readonly byId = new Map<string, PuzzleComponent>();
  /** Signal id -> the component label that raises it, for readable schematics. */
  private readonly sourceLabel = new Map<string, string>();

  constructor(defs: PuzzleDef[]) {
    for (const def of defs) {
      this.puzzles.push(def);
      const made = def.components.map(makeComponent);
      this.byPuzzle.set(def.id, made);
      for (const c of made) {
        this.components.push(c);
        this.byId.set(c.id, c);
        for (const sig of c.emits) this.sourceLabel.set(sig, c.label);
      }
    }
  }

  update(ctx: PuzzleContext): void {
    this.bus.beginTick();
    for (const c of this.components) c.update(ctx);
  }

  /**
   * RETRACE, catch and collapse all land here. Every component drops its timers
   * and latches, and the bus is wiped — so no puzzle can carry half-solved state
   * into the next attempt and no combination of signals can strand a run.
   */
  reset(): void {
    for (const c of this.components) c.reset();
    this.bus.clear();
  }

  get<T extends PuzzleComponent = PuzzleComponent>(id: string): T | null {
    return (this.byId.get(id) as T | undefined) ?? null;
  }

  componentsOf(puzzleId: string): PuzzleComponent[] {
    return this.byPuzzle.get(puzzleId) ?? [];
  }

  /** Every scanner pad, so the renderer can draw the floor markings. */
  scanners(): Scanner[] {
    return this.components.filter((c): c is Scanner => c instanceof Scanner);
  }

  mimicScanners(): MimicScanner[] {
    return this.components.filter((c): c is MimicScanner => c instanceof MimicScanner);
  }

  sensors(): SoundSensor[] {
    return this.components.filter((c): c is SoundSensor => c instanceof SoundSensor);
  }

  /** Names a signal by whatever raises it, falling back to the raw id. */
  nameOf(signal: string): string {
    return this.sourceLabel.get(signal) ?? signal.toUpperCase();
  }

  /** Human-readable condition, for the schematic terminal and door readouts. */
  describe(expr: SignalExpr): string {
    return describeExpr(expr, (id) => this.nameOf(id));
  }

  /**
   * Every puzzle whose bounds contain a point.
   *
   * Rooms deliberately hold more than one machine — the security wing has three
   * independent ways through its checkpoint — so this must return all of them.
   * Returning only the first meant four of the nine puzzles could never show a
   * readout, because a puzzle sharing its room was always found first.
   */
  puzzlesAt(x: number, y: number, tile: number): PuzzleDef[] {
    const tx = Math.floor(x / tile);
    const ty = Math.floor(y / tile);
    return this.puzzles.filter((p) => {
      const b = p.bounds;
      return b ? tx >= b.x && ty >= b.y && tx < b.x + b.w && ty < b.y + b.h : false;
    });
  }

  /** Every latch that brings a facility system online when solved. */
  objectiveLatches(): Latch[] {
    return this.components.filter((c): c is Latch => c instanceof Latch && c.completes !== null);
  }

  /** True once a named latch has tripped — how puzzles report "solved". */
  solved(latchId: string): boolean {
    const c = this.byId.get(latchId);
    return c instanceof Latch ? c.isLatched : false;
  }

  /** True when every latch belonging to a puzzle has tripped. */
  solvedFor(puzzleId: string): boolean {
    const latches = (this.byPuzzle.get(puzzleId) ?? []).filter(
      (c): c is Latch => c instanceof Latch,
    );
    return latches.length > 0 && latches.every((l) => l.isLatched);
  }

  /** Debug lines: every component and its live state. */
  debugLines(ctx: PuzzleContext): string[] {
    return this.components.map((c) => `${c.id}  ${c.status(ctx)}`);
  }
}
