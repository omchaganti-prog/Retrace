/**
 * Tiny pixel-art toolkit. All game art is generated at runtime into offscreen
 * canvases at native (1x) resolution, then blitted with nearest-neighbour
 * scaling. That keeps the repo asset-free and guarantees a consistent palette.
 */

export type Canvas = HTMLCanvasElement;
export type Ctx = CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): Canvas {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function ctxOf(c: Canvas): Ctx {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Draw into a fresh w x h canvas and return it. */
export function paint(w: number, h: number, fn: (p: Painter) => void): Canvas {
  const c = makeCanvas(w, h);
  fn(new Painter(ctxOf(c), w, h));
  return c;
}

/** Pixel-snapped drawing primitives. Coordinates are integer pixel indices. */
export class Painter {
  constructor(
    readonly ctx: Ctx,
    readonly w: number,
    readonly h: number,
  ) {}

  clear(): void {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  px(x: number, y: number, color: string, a = 1): void {
    if (a <= 0) return;
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.ctx.globalAlpha = a;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, 1, 1);
    this.ctx.globalAlpha = 1;
  }

  rect(x: number, y: number, w: number, h: number, color: string, a = 1): void {
    if (a <= 0 || w <= 0 || h <= 0) return;
    this.ctx.globalAlpha = a;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
    this.ctx.globalAlpha = 1;
  }

  /** 1px outline, inclusive of the given bounds. */
  frame(x: number, y: number, w: number, h: number, color: string, a = 1): void {
    this.rect(x, y, w, 1, color, a);
    this.rect(x, y + h - 1, w, 1, color, a);
    this.rect(x, y, 1, h, color, a);
    this.rect(x + w - 1, y, 1, h, color, a);
  }

  /** Filled rect with the 4 corner pixels removed — reads as "rounded" at 1x. */
  roundRect(x: number, y: number, w: number, h: number, color: string, a = 1): void {
    this.rect(x, y, w, h, color, a);
    if (w < 3 || h < 3) return;
    this.ctx.clearRect(x, y, 1, 1);
    this.ctx.clearRect(x + w - 1, y, 1, 1);
    this.ctx.clearRect(x, y + h - 1, 1, 1);
    this.ctx.clearRect(x + w - 1, y + h - 1, 1, 1);
  }

  /** Filled disc centred on (cx, cy) — centres may be on half-pixels. */
  disc(cx: number, cy: number, r: number, color: string, a = 1): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.px(x, y, color, a);
      }
    }
  }

  ring(cx: number, cy: number, r: number, color: string, a = 1): void {
    const outer = r * r;
    const inner = (r - 1) * (r - 1);
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = dx * dx + dy * dy;
        if (d <= outer && d > inner) this.px(x, y, color, a);
      }
    }
  }

  /** Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, color: string, a = 1): void {
    x0 |= 0;
    y0 |= 0;
    x1 |= 0;
    y1 |= 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, color, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * Deterministic per-pixel speckle. Used for surface grain so tiles do not look
   * flat, without needing texture assets.
   */
  noise(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    density: number,
    seed: number,
    a = 1,
  ): void {
    let s = seed >>> 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
        if ((s >>> 8) / 0x1000000 < density) this.px(x + i, y + j, color, a);
      }
    }
  }
}

/** Recolour a sprite, preserving its alpha silhouette. */
export function tint(src: Canvas, color: string, strength = 1): Canvas {
  const out = makeCanvas(src.width, src.height);
  const ctx = ctxOf(out);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.globalAlpha = strength;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/** Multiply every pixel's alpha — used for ECHO ghosting. */
export function fade(src: Canvas, a: number): Canvas {
  const out = makeCanvas(src.width, src.height);
  const ctx = ctxOf(out);
  ctx.globalAlpha = a;
  ctx.drawImage(src, 0, 0);
  ctx.globalAlpha = 1;
  return out;
}

/** 1px silhouette halo around a sprite, drawn beneath it. */
export function outline(src: Canvas, color: string, a = 1): Canvas {
  const out = makeCanvas(src.width + 2, src.height + 2);
  const ctx = ctxOf(out);
  const mask = tint(src, color, 1);
  ctx.globalAlpha = a;
  for (const [dx, dy] of [
    [0, 1],
    [2, 1],
    [1, 0],
    [1, 2],
  ]) {
    ctx.drawImage(mask, dx, dy);
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(src, 1, 1);
  return out;
}

export interface Anim {
  frames: Canvas[];
  /** Seconds per frame. */
  frameTime: number;
  loop: boolean;
}

export function anim(frames: Canvas[], frameTime: number, loop = true): Anim {
  return { frames, frameTime, loop };
}

export function frameAt(a: Anim, t: number): Canvas {
  if (a.frames.length === 1) return a.frames[0];
  const i = Math.floor(t / a.frameTime);
  return a.loop
    ? a.frames[((i % a.frames.length) + a.frames.length) % a.frames.length]
    : a.frames[Math.min(i, a.frames.length - 1)];
}
