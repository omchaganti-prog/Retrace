import type { ObjectiveId } from "../core/constants";
import type { SignalExpr } from "../puzzle/signals";

export type PropKind = "lever" | "terminal" | "console" | "plate" | "camera" | "exit";

export interface PropDef {
  id: string;
  kind: PropKind;
  tx: number;
  ty: number;
  /** Prompt shown when the player is in range. */
  label?: string;
  /** Objective flag set when this prop is activated. Persists across resets. */
  objective?: ObjectiveId;
  /** Objective flags that must already be set before this prop responds. */
  requires?: ObjectiveId[];
  /** Camera only: centre of its sweep, in radians. */
  facing?: number;
  /** Camera only: half-width of its sweep, in radians. */
  sweep?: number;
  /** Camera only: seconds for a full back-and-forth sweep. */
  sweepPeriod?: number;
}

export interface Prop extends PropDef {
  /** Levers/terminals/consoles: latched on. Plates: pressed right now. */
  active: boolean;
  /** Plates: how many bodies are standing on it this tick. */
  weight: number;
  /** Seconds since state last changed — drives the art. */
  since: number;
  /** Cameras: current aim angle and alert timer. */
  aim: number;
  alertT: number;
}

export type DoorRule =
  /** Sci-fi corridor door: slides open for anything that walks up to it. */
  | { kind: "auto" }
  /** Security door: open only while every listed plate is weighted. */
  | { kind: "plates"; plates: string[] }
  /** Bulkhead: opens once the listed objectives are complete, and stays open. */
  | { kind: "flags"; flags: ObjectiveId[] }
  /**
   * Puzzle door: open while an arbitrary expression over the signal bus holds.
   * This is what lets a door be driven by scanners, microphones, a camera's
   * false report or MIMIC's own security clearance without the door knowing
   * anything about any of them.
   */
  | { kind: "signal"; expr: SignalExpr };

export interface DoorDef {
  id: string;
  tx: number;
  ty: number;
  rule: DoorRule;
  label?: string;
  /**
   * MIMIC may seal this door temporarily. Deliberately opt-in and restricted to
   * corridor hatches: an objective gate or the lift bulkhead must never be
   * lockable, or a run could be stranded behind it.
   */
  mimicControllable?: boolean;
}

export interface Door extends DoorDef {
  /** 0 = sealed, 1 = fully retracted. */
  openness: number;
  /** Seconds left under a MIMIC security override. */
  lockedT: number;
  /** True while the rule is satisfied. */
  powered: boolean;
  /** Passage runs north-south (true) or east-west (false); set by the builder. */
  passageNS: boolean;
  /** Set for one tick when the door finishes opening, so it can emit a sound. */
  justOpened: boolean;
}

export function makeProp(def: PropDef): Prop {
  return {
    ...def,
    active: false,
    weight: 0,
    since: 999,
    aim: def.facing ?? 0,
    alertT: 0,
  };
}

export function makeDoor(def: DoorDef): Door {
  return { ...def, openness: 0, powered: false, passageNS: true, justOpened: false, lockedT: 0 };
}

/** Doors block sight until they are most of the way open. */
export function doorBlocksSight(d: Door): boolean {
  return d.openness < 0.8;
}

export function doorBlocksMove(d: Door): boolean {
  return d.openness < 0.55;
}
