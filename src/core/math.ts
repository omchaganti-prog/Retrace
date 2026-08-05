export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y });

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential approach. `rate` = fraction closed per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

/** Shortest signed angular difference from `a` to `b`, in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function approachAngle(a: number, b: number, maxStep: number): number {
  const d = angleDelta(a, b);
  return a + clamp(d, -maxStep, maxStep);
}

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Eight-way facing, counter-clockwise from east in screen space (+y is down):
 *
 *   0 E   1 SE   2 S   3 SW   4 W   5 NW   6 N   7 NE
 *
 * Eight rather than four so a diagonal reads as a diagonal. With four, moving
 * down-right snapped to whichever axis happened to dominate and the character
 * looked like it was walking sideways.
 */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const DIR_COUNT = 8;
const DIR_STEP = Math.PI / 4;

export function dirFromVector(dx: number, dy: number, fallback: Dir): Dir {
  if (dx === 0 && dy === 0) return fallback;
  const idx = Math.round(Math.atan2(dy, dx) / DIR_STEP);
  return (((idx % DIR_COUNT) + DIR_COUNT) % DIR_COUNT) as Dir;
}

/** Facing angle in radians for a direction index. */
export const dirAngle = (d: Dir): number => d * DIR_STEP;

/** Unit facing vector for a direction index. */
export function dirVector(d: Dir): { x: number; y: number } {
  const a = dirAngle(d);
  return { x: Math.cos(a), y: Math.sin(a) };
}
