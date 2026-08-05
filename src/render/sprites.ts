/**
 * All RETRACE art is generated procedurally at boot — no external asset files.
 * The style brief is "clean geometric shapes, bold colours, limited palette",
 * which suits code-drawn pixel art and keeps the project free of licence
 * obligations. Everything is authored at 1x (16px tiles) and scaled up.
 */
import { TILE } from "../core/constants";
import { DIR_COUNT } from "../core/math";
import { PAL, alpha } from "./palette";
import {
  type Anim,
  type Canvas,
  Painter,
  anim,
  ctxOf,
  fade,
  makeCanvas,
  paint,
  tint,
} from "./pixels";

/** Poses are derived from the facing vector, so all eight read consistently. */
const facing = (dir: number): { fx: number; fy: number } => {
  const a = (dir * Math.PI) / 4;
  return { fx: Math.cos(a), fy: Math.sin(a) };
};

/**
 * The visor, per facing — width and offset within the 6px head.
 *
 * Hand-authored rather than derived: at this size a smooth function rounds the
 * diagonals onto their neighbouring cardinals and SE ends up pixel-identical to
 * E. Explicit widths give all eight a distinct silhouette. `null` means the head
 * is turned away entirely.
 *
 * Index order: 0 E, 1 SE, 2 S, 3 SW, 4 W, 5 NW, 6 N, 7 NE.
 */
const VISOR: readonly ({ w: number; x: number } | null)[] = [
  { w: 2, x: 4 }, // E  — a slit hard against the leading edge
  { w: 3, x: 2 }, // SE — angled, part of the face still visible
  { w: 4, x: 1 }, // S  — full face
  { w: 3, x: 1 }, // SW
  { w: 2, x: 0 }, // W
  { w: 1, x: 0 }, // NW — barely a sliver, turning away
  null, //           N  — fully away
  { w: 1, x: 5 }, // NE
];

interface SuitColors {
  body: string;
  dark: string;
  light: string;
  visor: string;
  accent: string;
}

const PLAYER_SUIT: SuitColors = {
  body: PAL.cyanDim,
  dark: PAL.cyanDeep,
  light: PAL.cyan,
  visor: PAL.cyanBright,
  accent: PAL.white,
};

/**
 * One 16x16 humanoid frame. `phase` drives a 6-step walk cycle; `phase < 0`
 * means idle. `dir` is one of the eight compass facings.
 *
 * The pose is built from the facing vector rather than a per-direction switch,
 * so the four diagonals are genuinely distinct poses — shoulders turned, visor
 * offset, legs stepping the way the body is actually travelling — instead of
 * reusing the nearest cardinal frame.
 */
function drawAgent(p: Painter, dir: number, phase: number, c: SuitColors): void {
  const { fx, fy } = facing(dir);
  const walking = phase >= 0;
  const step = walking ? phase % 6 : -1;
  // Vertical bob on the two "push off" frames of the cycle.
  const bob = step === 1 || step === 4 ? -1 : 0;
  // -1, 0, +1 swing used to offset the leading leg.
  const swing = walking ? [1, 1, 0, -1, -1, 0][step] : 0;

  // Contact shadow, nudged behind the direction of travel.
  const shx = Math.round(-fx);
  p.rect(5 + shx, 14, 6, 1, PAL.black, 0.45);
  p.rect(6 + shx, 15, 4, 1, PAL.black, 0.25);

  const top = 2 + bob;
  // How side-on the body is. Drives whether the legs stride or alternate.
  const sideOn = Math.abs(fx);
  // Whole-body lean into the direction of travel. Scaled so a pure side-on
  // facing leans 2px and a diagonal leans 1 — at 1.4 both rounded to 1 and the
  // diagonals were pixel-identical to the cardinals.
  const lean = Math.round(fx * 2);

  // Legs.
  if (sideOn < 0.4) {
    // Facing the camera or away: legs alternate in place.
    p.rect(5, 11 + bob, 2, 3 + (swing > 0 ? 0 : 1), c.dark);
    p.rect(9, 11 + bob, 2, 3 + (swing < 0 ? 0 : 1), c.dark);
  } else {
    // Side-on or diagonal: one leg leads, and the stride follows the heading.
    const lead = fx < 0 ? -swing : swing;
    p.rect(6 + Math.max(0, lead) + lean, 11 + bob, 2, 4, c.dark);
    p.rect(8 + Math.min(0, lead) + lean, 11 + bob, 2, 4, c.body);
  }

  // Torso, narrowed as it turns side-on so the shoulders read as rotated.
  const torsoX = 5 + lean;
  const torsoW = sideOn > 0.9 ? 5 : 6;
  p.roundRect(torsoX, top + 4, torsoW, 7, c.body);
  p.rect(torsoX - 1, top + 5, 1, 3, c.dark);
  p.rect(torsoX + torsoW, top + 5, 1, 3, c.dark);

  // Chest light — the thing MIMIC's eye locks onto. Hidden when facing away.
  if (fy > -0.45) {
    const cx = torsoX + (torsoW === 5 ? 2 : 2) + Math.round(fx * 0.8);
    p.rect(cx, top + 6, 2, 2, c.light);
    p.px(cx, top + 6, c.accent, 0.9);
  }

  // Head.
  const headX = 5 + lean;
  p.roundRect(headX, top, 6, 5, c.body);
  p.rect(headX, top, 6, 1, c.light, 0.5);

  const visor = VISOR[dir];
  if (visor) {
    const vx = headX + visor.x;
    p.rect(vx, top + 2, visor.w, 2, c.visor);
    // Bright pixel on the leading edge — reads as the direction of gaze.
    p.px(fx >= 0 ? vx + visor.w - 1 : vx, top + 2, PAL.white);
  }
  // Turning away also shows the nape, offset with the turn. Combined with the
  // visor sliver this is what separates NE and NW from a straight N.
  if (fy < -0.3) {
    p.rect(headX + 1 + Math.round(fx * 1.2), top + 3, 4, 1, c.dark);
  }
}

function agentAnims(c: SuitColors): { idle: Anim[]; walk: Anim[] } {
  const idle: Anim[] = [];
  const walk: Anim[] = [];
  for (let dir = 0; dir < DIR_COUNT; dir++) {
    idle.push(anim([paint(TILE, TILE, (p) => drawAgent(p, dir, -1, c))], 1));
    const frames: Canvas[] = [];
    for (let f = 0; f < 6; f++) {
      frames.push(paint(TILE, TILE, (p) => drawAgent(p, dir, f, c)));
    }
    walk.push(anim(frames, 0.09));
  }
  return { idle, walk };
}

/**
 * MIMIC's shell, with no eye on it.
 *
 * The eye used to be baked into these frames, one per facing direction, which
 * meant it could only ever do the eight things the spritesheet knew about. It
 * is now drawn live over this shell so it can contract, widen, flicker and
 * track independently of the body — see `mimic-eye.ts`.
 */
function drawMimicShell(p: Painter, pulse: number, alert: boolean): void {
  const cx = 8;
  const cy = 7.5 - pulse * 0.5;

  p.disc(8, 14, 3.4, PAL.black, 0.4);
  p.rect(6, 15, 4, 1, PAL.black, 0.25);

  const haloA = alert ? 0.3 : 0.14;
  p.ring(cx, cy, 7.2, alert ? PAL.red : PAL.redDeep, haloA);

  p.disc(cx, cy, 6, PAL.mimicRim);
  p.disc(cx, cy, 5.3, PAL.mimicBody);
  p.ring(cx, cy, 6, PAL.redDeep, 0.55);
  // Specular arc across the top-left of the shell.
  p.px(cx - 3, cy - 4, PAL.grey, 0.35);
  p.px(cx - 2, cy - 5, PAL.grey, 0.28);
}

function mimicShellAnims(): { idle: Anim[]; alert: Anim[] } {
  // Direction-independent: the shell is a symmetrical disc, so one animation
  // serves every facing and the spritesheet shrinks by a factor of eight.
  const pulses = [0, 0.5, 1, 0.5];
  return {
    idle: [anim(pulses.map((v) => paint(TILE, TILE, (p) => drawMimicShell(p, v, false))), 0.18)],
    alert: [anim([0, 1].map((v) => paint(TILE, TILE, (p) => drawMimicShell(p, v, true))), 0.1)],
  };
}

/** MIMIC: a floating dark orb with one large red eye. */
function drawMimic(p: Painter, dir: number, pulse: number, alert: boolean): void {
  const { fx: dx, fy: dy } = facing(dir);
  const cx = 8;
  const cy = 7.5 - pulse * 0.5;

  p.disc(8, 14, 3.4, PAL.black, 0.4);
  p.rect(6, 15, 4, 1, PAL.black, 0.25);

  // Halo.
  const haloA = alert ? 0.3 : 0.14;
  p.ring(cx, cy, 7.2, alert ? PAL.red : PAL.redDeep, haloA);

  // Body.
  p.disc(cx, cy, 6, PAL.mimicRim);
  p.disc(cx, cy, 5.3, PAL.mimicBody);
  p.ring(cx, cy, 6, PAL.redDeep, 0.55);
  // Specular arc across the top-left of the shell.
  p.px(cx - 3, cy - 4, PAL.grey, 0.35);
  p.px(cx - 2, cy - 5, PAL.grey, 0.28);

  // Eye, offset toward the facing direction.
  const ex = cx + dx * 1.9;
  const ey = cy + dy * 1.9;
  const r = alert ? 3.1 : 2.2 + pulse * 0.45;
  p.disc(ex, ey, r + 1, PAL.redDeep, 0.7);
  p.disc(ex, ey, r, PAL.red);
  p.disc(ex, ey, r * 0.5, PAL.redBright);
  if (alert) p.px(Math.round(ex - 0.5), Math.round(ey - 0.5), PAL.white);
}

function mimicAnims(): { idle: Anim[]; alert: Anim[] } {
  const idle: Anim[] = [];
  const alert: Anim[] = [];
  const pulses = [0, 0.5, 1, 0.5];
  for (let dir = 0; dir < DIR_COUNT; dir++) {
    idle.push(
      anim(
        pulses.map((v) => paint(TILE, TILE, (p) => drawMimic(p, dir, v, false))),
        0.18,
      ),
    );
    alert.push(
      anim(
        [0, 1].map((v) => paint(TILE, TILE, (p) => drawMimic(p, dir, v, true))),
        0.1,
      ),
    );
  }
  return { idle, alert };
}

/* ------------------------------------------------------------------ tiles */

function drawFloor(p: Painter, variant: number): void {
  p.rect(0, 0, TILE, TILE, PAL.floor);
  p.noise(0, 0, TILE, TILE, PAL.floorLit, 0.05, 0x51a3 + variant * 7717, 0.5);
  p.noise(0, 0, TILE, TILE, PAL.floorSeam, 0.05, 0x77b1 + variant * 3313, 0.6);
  // Panel seams every other tile so the floor reads as plating.
  p.rect(0, 0, TILE, 1, PAL.floorSeam, 0.8);
  p.rect(0, 0, 1, TILE, PAL.floorSeam, 0.8);
  if (variant === 1) {
    p.rect(3, 3, 10, 10, PAL.floorDark, 0.5);
    p.frame(3, 3, 10, 10, PAL.floorLit, 0.25);
  } else if (variant === 2) {
    p.rect(2, 7, 12, 1, PAL.floorLit, 0.22);
    p.rect(2, 9, 12, 1, PAL.floorSeam, 0.5);
  } else if (variant === 3) {
    p.px(4, 5, PAL.cyanDeep, 0.5);
    p.px(11, 10, PAL.greyDark, 0.6);
  }
}

function drawGrate(p: Painter): void {
  p.rect(0, 0, TILE, TILE, PAL.grate);
  for (let y = 1; y < TILE; y += 3) p.rect(1, y, TILE - 2, 1, PAL.floorSeam, 0.9);
  p.frame(0, 0, TILE, TILE, PAL.floorSeam, 0.8);
  p.noise(0, 0, TILE, TILE, PAL.greyDark, 0.04, 0x1234, 0.4);
}

/** Shadow-zone floor: a dark alcove the player can hide in. */
function drawShadowFloor(p: Painter): void {
  p.rect(0, 0, TILE, TILE, PAL.floorDark);
  p.noise(0, 0, TILE, TILE, PAL.black, 0.3, 0x9911, 0.5);
  p.frame(0, 0, TILE, TILE, PAL.black, 0.5);
}

function drawWall(p: Painter, variant: number): void {
  p.rect(0, 0, TILE, TILE, PAL.wall);
  p.rect(1, 1, TILE - 2, TILE - 3, PAL.wallFace);
  p.rect(1, 1, TILE - 2, 1, PAL.wallEdge, 0.8);
  p.rect(1, 1, 1, TILE - 3, PAL.wallEdge, 0.45);
  p.rect(1, TILE - 2, TILE - 2, 1, PAL.wallShadow, 0.9);
  p.rect(TILE - 2, 1, 1, TILE - 3, PAL.wallShadow, 0.6);
  p.noise(1, 2, TILE - 2, TILE - 4, PAL.wallEdge, 0.03, 0x33aa + variant * 991, 0.35);
  if (variant === 1) {
    p.rect(4, 5, 8, 1, PAL.wallEdge, 0.3);
    p.rect(4, 9, 8, 1, PAL.wallShadow, 0.5);
  } else if (variant === 2) {
    p.rect(6, 4, 4, 6, PAL.wall, 0.7);
    p.frame(6, 4, 4, 6, PAL.wallEdge, 0.25);
  } else if (variant === 3) {
    p.px(3, 3, PAL.cyanDeep, 0.5);
    p.px(12, 11, PAL.wallEdge, 0.4);
  }
}

/* ------------------------------------------------------------------ props */

function drawPlate(p: Painter, pressed: boolean): void {
  const c = pressed ? PAL.green : PAL.cyanDim;
  p.rect(2, 2, 12, 12, PAL.floorDark);
  p.frame(2, 2, 12, 12, PAL.greyDark);
  const inset = pressed ? 2 : 1;
  p.rect(3 + inset, 3 + inset, 12 - 2 * inset - 2, 12 - 2 * inset - 2, PAL.floor);
  p.frame(3 + inset, 3 + inset, 12 - 2 * inset - 2, 12 - 2 * inset - 2, c, pressed ? 1 : 0.8);
  p.px(7, 8, c);
  p.px(8, 8, c);
  if (!pressed) {
    p.rect(4, 12, 8, 1, PAL.wallShadow, 0.6);
  }
}

function drawTerminal(p: Painter, on: boolean, flicker: number): void {
  // Housing.
  p.rect(2, 4, 12, 10, PAL.wall);
  p.frame(2, 4, 12, 10, PAL.wallEdge, 0.8);
  p.rect(3, 13, 10, 1, PAL.wallShadow);
  // Screen.
  const glow = on ? (flicker === 1 ? PAL.amber : PAL.amberDim) : PAL.floorDark;
  p.rect(4, 5, 8, 6, PAL.black);
  p.rect(4, 5, 8, 6, glow, on ? 0.55 : 1);
  if (on) {
    for (let i = 0; i < 4; i++) {
      const w = 2 + ((i * 3 + flicker) % 5);
      p.rect(5, 6 + i, w, 1, PAL.amber, flicker === 2 && i === 1 ? 0.2 : 0.95);
    }
  } else {
    p.rect(5, 8, 6, 1, PAL.greyDark, 0.6);
  }
  p.rect(6, 12, 4, 1, on ? PAL.amber : PAL.greyDark, 0.9);
}

function drawLever(p: Painter, on: boolean): void {
  p.rect(3, 5, 10, 9, PAL.wall);
  p.frame(3, 5, 10, 9, PAL.wallEdge, 0.8);
  p.rect(5, 7, 6, 5, PAL.floorDark);
  const c = on ? PAL.green : PAL.red;
  if (on) {
    p.rect(7, 6, 2, 4, PAL.grey);
    p.rect(6, 5, 4, 2, c);
  } else {
    p.rect(7, 9, 2, 4, PAL.grey);
    p.rect(6, 12, 4, 2, c);
  }
  p.px(4, 6, c, 0.9);
  p.px(11, 6, c, 0.9);
}

function drawConsole(p: Painter, on: boolean, f: number): void {
  p.rect(1, 3, 14, 11, PAL.wall);
  p.frame(1, 3, 14, 11, PAL.wallEdge, 0.85);
  p.rect(2, 13, 12, 1, PAL.wallShadow);
  const c = on ? PAL.green : PAL.red;
  p.rect(3, 5, 10, 6, PAL.black);
  p.frame(3, 5, 10, 6, c, 0.6);
  // Containment bar graph.
  for (let i = 0; i < 5; i++) {
    const h = on ? 1 : 1 + ((i + f) % 4);
    p.rect(4 + i * 2, 10 - h, 1, h, c, 0.9);
  }
  p.rect(4, 12, 3, 1, c, f % 2 ? 1 : 0.4);
  p.rect(9, 12, 3, 1, PAL.greyDark, 0.7);
}

function drawExit(p: Painter, f: number, open: boolean): void {
  p.rect(1, 1, 14, 14, PAL.floorDark);
  p.frame(1, 1, 14, 14, open ? PAL.green : PAL.greyDark, 0.9);
  const c = open ? PAL.green : PAL.greyDark;
  const a = open ? 0.5 + 0.5 * Math.sin((f / 4) * Math.PI * 2) : 0.35;
  p.frame(3, 3, 10, 10, c, a);
  p.frame(5, 5, 6, 6, c, a * 0.8);
  // Up-arrow: "surface".
  p.line(8, 5, 5, 9, c, a);
  p.line(8, 5, 10, 9, c, a);
  p.rect(7, 8, 2, 4, c, a);
}

/** Camera dome; the lens shifts toward its aim direction (8 octants). */
function drawCamera(p: Painter, octant: number, alerted: boolean): void {
  const ang = (octant / 8) * Math.PI * 2;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  p.disc(8, 8, 6, PAL.wall);
  p.ring(8, 8, 6, PAL.wallEdge, 0.9);
  p.disc(8, 8, 4.5, PAL.floorDark);
  const c = alerted ? PAL.red : PAL.cyanDim;
  p.disc(8 + dx * 2.2, 8 + dy * 2.2, 2, c);
  p.px(Math.round(8 + dx * 2.2), Math.round(8 + dy * 2.2), PAL.white, 0.9);
  p.px(3, 3, alerted ? PAL.red : PAL.greyDark, 0.9);
}

/**
 * Door panels retracting into the frame. `vertical` = the door plugs a gap in a
 * vertical wall run (passage runs east-west), so the panels slide up and down.
 */
function drawDoor(p: Painter, openness: number, vertical: boolean): void {
  const retract = Math.round(openness * 7);
  if (vertical) {
    p.rect(0, 0, TILE, 2, PAL.wall);
    p.rect(0, TILE - 2, TILE, 2, PAL.wall);
    p.rect(0, 2 - retract, TILE, 6, PAL.wallFace);
    p.rect(0, 2 - retract + 5, TILE, 1, PAL.cyanDim, 0.8);
    p.rect(0, TILE - 8 + retract, TILE, 6, PAL.wallFace);
    p.rect(0, TILE - 8 + retract, TILE, 1, PAL.cyanDim, 0.8);
  } else {
    p.rect(0, 0, 2, TILE, PAL.wall);
    p.rect(TILE - 2, 0, 2, TILE, PAL.wall);
    p.rect(2 - retract, 0, 6, TILE, PAL.wallFace);
    p.rect(2 - retract + 5, 0, 1, TILE, PAL.cyanDim, 0.8);
    p.rect(TILE - 8 + retract, 0, 6, TILE, PAL.wallFace);
    p.rect(TILE - 8 + retract, 0, 1, TILE, PAL.cyanDim, 0.8);
  }
}

/* ----------------------------------------------------------------- glows */

/** Soft radial light sprite used additively for glows and lamps. */
function glow(size: number, color: string, power = 1): Canvas {
  const c = makeCanvas(size, size);
  const ctx = ctxOf(c);
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, alpha(color, 0.9 * power));
  g.addColorStop(0.4, alpha(color, 0.32 * power));
  g.addColorStop(0.75, alpha(color, 0.08 * power));
  g.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/* ------------------------------------------------------------------ build */

export interface Art {
  player: { idle: Anim[]; walk: Anim[] };
  echo: { idle: Anim[]; walk: Anim[] };
  mimic: { idle: Anim[]; alert: Anim[] };
  /** Shell only; the eye is drawn live on top. */
  mimicShell: { idle: Anim[]; alert: Anim[] };
  floors: Canvas[];
  walls: Canvas[];
  grate: Canvas;
  shadowFloor: Canvas;
  plate: [Canvas, Canvas];
  terminalOff: Canvas;
  terminalOn: Anim;
  lever: [Canvas, Canvas];
  consoleOff: Anim;
  consoleOn: Canvas;
  exitClosed: Canvas;
  exitOpen: Anim;
  camera: { idle: Canvas[]; alert: Canvas[] };
  doorH: Canvas[];
  doorV: Canvas[];
  glowCyan: Canvas;
  glowRed: Canvas;
  glowAmber: Canvas;
  glowGreen: Canvas;
  glowWhite: Canvas;
}

let cached: Art | null = null;

export function buildArt(): Art {
  if (cached) return cached;

  const player = agentAnims(PLAYER_SUIT);
  // ECHO reuses the player's exact frames — same silhouette, ghosted tint. That
  // is the point: an ECHO *is* a previous you.
  const ghost = (a: Anim): Anim =>
    anim(
      a.frames.map((f) => fade(tint(f, PAL.echo, 0.55), 0.72)),
      a.frameTime,
      a.loop,
    );

  const doorFrames = (vertical: boolean): Canvas[] =>
    Array.from({ length: 6 }, (_, i) =>
      paint(TILE, TILE, (p) => drawDoor(p, i / 5, vertical)),
    );

  cached = {
    player,
    echo: {
      idle: player.idle.map(ghost),
      walk: player.walk.map(ghost),
    },
    mimic: mimicAnims(),
    mimicShell: mimicShellAnims(),
    floors: [0, 1, 2, 3, 0, 2].map((v) => paint(TILE, TILE, (p) => drawFloor(p, v))),
    walls: [0, 1, 2, 3].map((v) => paint(TILE, TILE, (p) => drawWall(p, v))),
    grate: paint(TILE, TILE, drawGrate),
    shadowFloor: paint(TILE, TILE, drawShadowFloor),
    plate: [
      paint(TILE, TILE, (p) => drawPlate(p, false)),
      paint(TILE, TILE, (p) => drawPlate(p, true)),
    ],
    terminalOff: paint(TILE, TILE, (p) => drawTerminal(p, false, 0)),
    terminalOn: anim(
      [0, 1, 2, 1].map((f) => paint(TILE, TILE, (p) => drawTerminal(p, true, f))),
      0.13,
    ),
    lever: [
      paint(TILE, TILE, (p) => drawLever(p, false)),
      paint(TILE, TILE, (p) => drawLever(p, true)),
    ],
    consoleOff: anim(
      [0, 1, 2, 3].map((f) => paint(TILE, TILE, (p) => drawConsole(p, false, f))),
      0.15,
    ),
    consoleOn: paint(TILE, TILE, (p) => drawConsole(p, true, 0)),
    exitClosed: paint(TILE, TILE, (p) => drawExit(p, 0, false)),
    exitOpen: anim(
      [0, 1, 2, 3].map((f) => paint(TILE, TILE, (p) => drawExit(p, f, true))),
      0.14,
    ),
    camera: {
      idle: Array.from({ length: 8 }, (_, o) =>
        paint(TILE, TILE, (p) => drawCamera(p, o, false)),
      ),
      alert: Array.from({ length: 8 }, (_, o) =>
        paint(TILE, TILE, (p) => drawCamera(p, o, true)),
      ),
    },
    doorH: doorFrames(false),
    doorV: doorFrames(true),
    glowCyan: glow(96, PAL.cyan),
    glowRed: glow(96, PAL.red),
    glowAmber: glow(64, PAL.amber),
    glowGreen: glow(64, PAL.green),
    glowWhite: glow(128, PAL.white),
  };
  return cached;
}
