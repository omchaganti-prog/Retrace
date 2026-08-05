/**
 * An ECHO the player never recorded.
 *
 * This is the story's single most important trick, and it works because it is
 * not a trick at all: an Old ECHO is a genuine `EchoRecording`, built from a
 * scripted path and handed to the same manager that replays your own. It walks
 * with the same code, animates on the same clock, and holds the same pads.
 *
 * The only difference is where the data came from — which is exactly the
 * unsettling part. The player has spent hours learning that a cyan figure means
 * "something I did". Then one does something they never did.
 */
import { TICK_RATE } from "../core/constants";
import { type Dir, dirFromVector } from "../core/math";
import type { EchoAction, EchoRecording } from "../systems/echo";
import { tileCenter } from "../world/level";

const FLAG_MOVING = 1;
const DIR_SHIFT = 2;

export interface OldEchoStep {
  /** Tile to walk to. */
  tx: number;
  ty: number;
  /** Seconds to stand still on arrival. */
  pause?: number;
}

export interface OldEchoDef {
  id: string;
  /** Where it fades in. */
  from: { tx: number; ty: number };
  steps: OldEchoStep[];
  /** Tiles per second. Deliberately slower than the player: it is tired. */
  speed?: number;
}

/**
 * Bakes a path into a recording the ECHO system can replay verbatim.
 *
 * Walking the path here rather than at playback time means an Old ECHO is
 * frame-indexed against the same 60 Hz clock as everything else, so it stays in
 * sync with the player's own ECHOs and with the puzzle components it passes.
 */
export function buildOldEcho(def: OldEchoDef, run: number): EchoRecording {
  const speed = (def.speed ?? 2.6) * 16; // pixels per second
  const xs: number[] = [];
  const ys: number[] = [];
  const flags: number[] = [];
  const actions: EchoAction[] = [];

  let cur = tileCenter(def.from.tx, def.from.ty);
  let dir: Dir = 2;

  const push = (x: number, y: number, moving: boolean): void => {
    xs.push(x);
    ys.push(y);
    flags.push((moving ? FLAG_MOVING : 0) | (dir << DIR_SHIFT));
  };

  // A beat of stillness before it moves, so the player has time to notice it.
  for (let i = 0; i < Math.round(0.8 * TICK_RATE); i++) push(cur.x, cur.y, false);

  for (const step of def.steps) {
    const goal = tileCenter(step.tx, step.ty);
    const dx = goal.x - cur.x;
    const dy = goal.y - cur.y;
    const span = Math.hypot(dx, dy);
    if (span > 0.5) {
      dir = dirFromVector(dx, dy, dir);
      const ticks = Math.max(1, Math.round((span / speed) * TICK_RATE));
      for (let i = 1; i <= ticks; i++) {
        push(cur.x + (dx * i) / ticks, cur.y + (dy * i) / ticks, true);
      }
      cur = goal;
    }
    for (let i = 0; i < Math.round((step.pause ?? 0) * TICK_RATE); i++) {
      push(cur.x, cur.y, false);
    }
  }

  return {
    id: def.id,
    length: xs.length,
    xs: Float32Array.from(xs),
    ys: Float32Array.from(ys),
    flags: Uint8Array.from(flags),
    actions,
    run,
  };
}

/**
 * The scripted sighting.
 *
 * It crosses the abandoned laboratory, stops at a dead terminal, stands there a
 * moment — then turns and faces the player before it goes. No dialogue, no
 * explanation, and it is never referred to again by anything in the game.
 */
export const OLD_ECHO_LAB: OldEchoDef = {
  id: "echo-archive-0",
  from: { tx: 44, ty: 12 },
  steps: [
    { tx: 44, ty: 8, pause: 0.4 },
    { tx: 45, ty: 7, pause: 2.4 },
    // Turns back toward the room's entrance — toward wherever you are standing.
    { tx: 46, ty: 8, pause: 2.8 },
  ],
  speed: 2.2,
};

/** Ids the renderer should draw in the corrupted style. */
export const OLD_ECHO_IDS = new Set([OLD_ECHO_LAB.id]);

export const isOldEcho = (id: string): boolean => OLD_ECHO_IDS.has(id);
