/**
 * Sound propagation.
 *
 * A noise is a budget of "loudness" measured in tiles. It spreads outward with
 * Dijkstra: one tile of budget per tile travelled, plus a hefty surcharge for
 * passing through a wall or a sealed door. So a sprint two rooms away is
 * inaudible, but a sprint through the doorway next to MIMIC is not — and
 * running loudly on purpose is a legitimate way to pull it off your route.
 *
 * ECHOs re-emit exactly the noises their original run made, which is what makes
 * a recorded sprint usable as bait.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import { SOUND, TILE } from "../core/constants";
import { type Level, NEIGHBOURS8 } from "../world/level";
import { doorBlocksSight } from "../world/props";
import { Tile } from "../world/tiles";

export type SoundKind =
  | "step"
  | "sprint"
  /** A creeping footfall. Barely clears the audible floor. */
  | "sneak"
  | "interact"
  | "door"
  | "retrace"
  | "alarm"
  | "impact"
  /** The dash burst. MIMIC hears this like any other movement noise. */
  | "dash"
  /**
   * MIMIC moving. The player has a small light radius, so this is very often
   * the only warning they get — a servo tick through a wall, getting clearer.
   */
  | "mimicStep"
  /* UI-only cues. These are played straight to the speakers and are never
   * emitted into the SoundBus, so MIMIC can never hear its own abilities. */
  /** The refused RETRACE buzz. */
  | "jam"
  /** Focus Scan / Deep Scan sweep. */
  | "scan"
  /** A door sealed by security override. */
  | "lock"
  /** Camera Link / prediction data chirp. */
  | "link"
  /** Power Surge discharge. */
  | "surge"
  /** Facility Override connection tone. */
  | "override"
  /** Rising wind-up while a dash charges. UI-only. */
  | "charge"
  /** Refused dash — not enough stamina. UI-only. */
  | "drained";

/**
 * Who made a noise.
 *
 * "mimic" exists so MIMIC can be *heard* without hearing itself — see
 * `loudestAt`. Its own footsteps must never enter its own investigation logic,
 * or it spends the game chasing the sound of its own feet.
 */
export type SoundSource = "player" | "echo" | "world" | "mimic";

export interface SoundEvent {
  x: number;
  y: number;
  /** Budget in tiles. */
  loudness: number;
  kind: SoundKind;
  source: SoundSource;
  /** ECHO id, when source === "echo". */
  ownerId?: string;
}

export interface Heard {
  event: SoundEvent;
  /** Residual loudness at the listener, in tiles. */
  level: number;
}

/** Cost to move *into* this tile, in loudness units. */
function enterCost(level: Level, tx: number, ty: number, diagonal: boolean): number {
  const base = diagonal ? Math.SQRT2 : 1;
  const t = level.at(tx, ty);
  if (t === Tile.Void) return Infinity;
  if (t === Tile.Wall) return base + SOUND.wallCost;
  const d = level.doorAt(tx, ty);
  if (d && doorBlocksSight(d)) return base + SOUND.doorCost;
  return base;
}

interface HeapItem {
  i: number;
  cost: number;
}

/** Minimal binary min-heap; the fields are hot enough to be worth not using a lib. */
class MinHeap {
  private a: HeapItem[] = [];

  get size(): number {
    return this.a.length;
  }

  clear(): void {
    this.a.length = 0;
  }

  push(item: HeapItem): void {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): HeapItem | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const rr = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (rr < a.length && a[rr].cost < a[m].cost) m = rr;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Residual loudness field for one emission, keyed by tile index. Tiles missing
 * from the map are inaudible. Bounded by the loudness budget, so this stays
 * cheap even when several sounds land on the same tick.
 */
export function propagate(
  level: Level,
  x: number,
  y: number,
  loudness: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const startX = Math.floor(x / TILE);
  const startY = Math.floor(y / TILE);
  if (!level.inBounds(startX, startY) || loudness <= SOUND.audibleFloor) return out;

  const budget = loudness - SOUND.audibleFloor;
  const best = new Map<number, number>();
  const heap = new MinHeap();
  const startIdx = level.idx(startX, startY);
  best.set(startIdx, 0);
  heap.push({ i: startIdx, cost: 0 });

  while (heap.size > 0) {
    const { i, cost } = heap.pop()!;
    if (cost > (best.get(i) ?? Infinity)) continue;
    out.set(i, loudness - cost);
    const tx = i % level.w;
    const ty = (i / level.w) | 0;
    for (const [dx, dy] of NEIGHBOURS8) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!level.inBounds(nx, ny)) continue;
      const step = enterCost(level, nx, ny, dx !== 0 && dy !== 0);
      if (!Number.isFinite(step)) continue;
      const nc = cost + step;
      if (nc > budget) continue;
      const ni = level.idx(nx, ny);
      if (nc < (best.get(ni) ?? Infinity)) {
        best.set(ni, nc);
        heap.push({ i: ni, cost: nc });
      }
    }
  }
  return out;
}

/** Residual loudness of a single emission at a listener position. */
export function loudnessAt(
  level: Level,
  ev: SoundEvent,
  listenerX: number,
  listenerY: number,
): number {
  const field = propagate(level, ev.x, ev.y, ev.loudness);
  const tx = Math.floor(listenerX / TILE);
  const ty = Math.floor(listenerY / TILE);
  if (!level.inBounds(tx, ty)) return 0;
  return field.get(level.idx(tx, ty)) ?? 0;
}

/**
 * Collects the noises made during a tick and answers "what did you hear?".
 * Each emission's field is computed once and reused for every listener.
 */
export class SoundBus {
  private pending: SoundEvent[] = [];
  private fields = new Map<SoundEvent, Map<number, number>>();
  /**
   * Kept for one tick so the renderer can draw expanding noise rings. `audible`
   * is filled in by whoever knows where the listener is, so a ring can be faded
   * to match what was actually heard rather than drawn at full strength through
   * three walls.
   */
  readonly visible: {
    x: number;
    y: number;
    loudness: number;
    age: number;
    source: SoundSource;
    audible: number;
  }[] = [];

  emit(level: Level, ev: SoundEvent): void {
    this.pending.push(ev);
    this.fields.set(ev, propagate(level, ev.x, ev.y, ev.loudness));
    this.visible.push({
      x: ev.x,
      y: ev.y,
      loudness: ev.loudness,
      age: 0,
      source: ev.source,
      audible: 0,
    });
  }

  /**
   * Residual loudness of one already-emitted event at a position, reusing the
   * field computed in `emit`. This is the number MIMIC hears, so anything that
   * wants to agree with MIMIC — the player's own speakers, for one — must ask
   * here rather than measuring straight-line distance through walls.
   */
  residualAt(ev: SoundEvent, level: Level, x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (!level.inBounds(tx, ty)) return 0;
    return this.fields.get(ev)?.get(level.idx(tx, ty)) ?? 0;
  }

  /**
   * The loudest thing audible at this position on this tick, if anything.
   *
   * `ignoreSource` lets a listener deafen itself to its own noise, which is the
   * only reason MIMIC can have footsteps at all.
   */
  loudestAt(level: Level, x: number, y: number, ignoreSource?: SoundSource): Heard | null {
    return this.loudestMatching(level, x, y, null, ignoreSource);
  }

  /**
   * The loudest audible thing of a given kind.
   *
   * A microphone tuned to impulses needs this rather than `loudestAt`. Asking
   * for the loudest sound and then checking its kind lets an unrelated footstep
   * on the same tick mask the dash the sensor was waiting for — the dash was
   * genuinely audible, it simply was not the loudest thing in the room.
   */
  loudestMatching(
    level: Level,
    x: number,
    y: number,
    kinds: readonly SoundKind[] | null,
    ignoreSource?: SoundSource,
  ): Heard | null {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (!level.inBounds(tx, ty)) return null;
    const key = level.idx(tx, ty);
    let bestEv: SoundEvent | null = null;
    let bestLevel = SOUND.audibleFloor;
    for (const ev of this.pending) {
      if (kinds && !kinds.includes(ev.kind)) continue;
      if (ignoreSource && ev.source === ignoreSource) continue;
      const lvl = this.fields.get(ev)?.get(key) ?? 0;
      if (lvl > bestLevel) {
        bestLevel = lvl;
        bestEv = ev;
      }
    }
    return bestEv ? { event: bestEv, level: bestLevel } : null;
  }

  /** Call once per tick, after every listener has queried. */
  endTick(dt: number): void {
    this.pending.length = 0;
    this.fields.clear();
    for (let i = this.visible.length - 1; i >= 0; i--) {
      this.visible[i].age += dt;
      if (this.visible[i].age > 0.6) this.visible.splice(i, 1);
    }
  }

  clear(): void {
    this.pending.length = 0;
    this.fields.clear();
    this.visible.length = 0;
  }
}

/**
 * Loudness for a footstep, given movement mode and the surface underfoot.
 *
 * Three modes, three very different budgets — this single number is what makes
 * the choice between speed and silence a real one.
 */
export function footstepLoudness(
  sprinting: boolean,
  surfaceGain: number,
  sneaking = false,
): number {
  const base = sprinting
    ? SOUND.footstepSprint
    : sneaking
      ? SOUND.footstepSneak
      : SOUND.footstepWalk;
  return base * surfaceGain;
}
