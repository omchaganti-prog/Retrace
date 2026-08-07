/**
 * World rendering.
 *
 * Everything is drawn at 1x into an offscreen buffer and blitted with
 * nearest-neighbour scaling, so the pixel art stays exact at any window size.
 *
 * The fog is not decoration: an entity standing on a tile the player cannot
 * currently see is not drawn at all. Explored geometry stays faintly visible
 * because you remember the layout — but you do not get to watch MIMIC move
 * through a room you left.
 */
import {
  CAMERA_SCALE,
  LIGHT,
  MIMIC as MIMIC_TUNING,
  TICK_RATE,
  TILE,
  VIEW_H,
  VIEW_W,
} from "../core/constants";
import { POWER } from "../ai/abilities";
import { clamp, dirVector } from "../core/math";
import type { Game } from "../game/game";
import { rayDistance } from "../systems/los";
import { isOldEcho } from "../story/old-echo";
import type { Prop } from "../world/props";
import { Tile } from "../world/tiles";
import { PAL, alpha } from "./palette";
import { type Canvas, type Ctx, ctxOf, frameAt, makeCanvas } from "./pixels";
import { type Art, buildArt } from "./sprites";

export const BUFFER_W = Math.floor(VIEW_W / CAMERA_SCALE);
export const BUFFER_H = Math.floor(VIEW_H / CAMERA_SCALE);
export const DISPLAY_W = BUFFER_W * CAMERA_SCALE;
export const DISPLAY_H = BUFFER_H * CAMERA_SCALE;

/** Below this light level an entity on the tile is simply not drawn. */
const ENTITY_VISIBLE = 0.09;

export class Renderer {
  readonly art: Art = buildArt();
  private buf: Canvas = makeCanvas(BUFFER_W, BUFFER_H);
  private bctx: Ctx = ctxOf(this.buf);
  /** Built once — a full-screen gradient is far too slow to make every frame. */
  private vignette: Canvas | null = null;
  private lamp: Canvas | null = null;
  camX = 0;
  camY = 0;

  draw(out: Ctx, game: Game): void {
    const g = this.bctx;
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = PAL.void;
    g.fillRect(0, 0, BUFFER_W, BUFFER_H);

    this.updateCamera(game);
    this.drawTiles(game);
    this.drawPuzzleFloor(game);
    this.drawDoors(game);
    this.drawProps(game);
    this.drawSoundRings(game);
    this.drawVisionCone(game);
    this.drawAbilityFx(game);
    this.drawEchoes(game);
    this.drawPlayer(game);
    this.drawMimic(game);
    this.drawGlows(game);
    // The eye goes on after the bloom. Drawn before it, the red glow washed
    // straight over the pupil and the aperture and MIMIC read as a featureless
    // bright blob — every shape cue the eye carries was being composited away.
    this.drawMimicEyePass(game);
    this.drawDust(game);
    this.drawLamp(game);
    this.drawVignette();

    this.blit(out, game);
  }

  /**
   * Smooth distance falloff around the player.
   *
   * Tile lighting is computed per tile, so on its own it steps in hard 16px
   * squares and the floor reads as a spreadsheet. This lays a continuous
   * gradient over the top: the steps are still there underneath, but the eye
   * follows the smooth edge instead of the staircase.
   *
   * Built once into an oversized canvas and blitted at an offset — a radial
   * gradient is far too expensive to construct every frame.
   */
  private drawLamp(game: Game): void {
    const w = BUFFER_W * 2;
    const h = BUFFER_H * 2;
    if (!this.lamp) {
      this.lamp = makeCanvas(w, h);
      const l = ctxOf(this.lamp);
      l.fillStyle = alpha(PAL.void, 0.5);
      l.fillRect(0, 0, w, h);
      // Carve the lit hole back out, so the darkness fades in with distance.
      const inner = LIGHT.playerRadiusTiles * TILE * 0.45;
      const outer = LIGHT.playerRadiusTiles * TILE * 1.15;
      const grad = l.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, outer);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      l.globalCompositeOperation = "destination-out";
      l.fillStyle = grad;
      l.fillRect(0, 0, w, h);
    }
    this.bctx.drawImage(
      this.lamp,
      Math.round(this.sx(game.player.x) - w / 2),
      Math.round(this.sy(game.player.y) - h / 2),
    );
  }

  /**
   * Darkens the corners. The fog already limits what you can see; this makes the
   * limit feel like a torch rather than a clipping rectangle.
   */
  private drawVignette(): void {
    const g = this.bctx;
    if (!this.vignette) {
      this.vignette = makeCanvas(BUFFER_W, BUFFER_H);
      const v = ctxOf(this.vignette);
      const grad = v.createRadialGradient(
        BUFFER_W / 2,
        BUFFER_H / 2,
        Math.min(BUFFER_W, BUFFER_H) * 0.3,
        BUFFER_W / 2,
        BUFFER_H / 2,
        Math.max(BUFFER_W, BUFFER_H) * 0.62,
      );
      grad.addColorStop(0, alpha(PAL.void, 0));
      grad.addColorStop(1, alpha(PAL.void, 0.75));
      v.fillStyle = grad;
      v.fillRect(0, 0, BUFFER_W, BUFFER_H);
    }
    g.drawImage(this.vignette, 0, 0);
  }

  /* ---------------------------------------------------------------- camera */

  private updateCamera(game: Game): void {
    const levelW = game.level.w * TILE;
    const levelH = game.level.h * TILE;
    const wantX = game.player.x - BUFFER_W / 2;
    const wantY = game.player.y - BUFFER_H / 2;
    // The kick moves the camera through the world rather than sliding the
    // finished frame around, so the edges stay filled with actual facility
    // instead of a black bar. Whole buffer pixels only — a sub-pixel camera
    // would smear every sprite on screen.
    let kx = 0;
    let ky = 0;
    const kick = clamp(game.shake, 0, 1) * game.settings.scale("screenShake");
    if (kick > 0.01) {
      const amp = kick * kick * 4;
      kx = Math.round(Math.sin(game.elapsed * 74) * amp);
      ky = Math.round(Math.cos(game.elapsed * 91) * amp * 0.7);
    }

    this.camX = Math.round(
      levelW <= BUFFER_W ? (levelW - BUFFER_W) / 2 : clamp(wantX + kx, 0, levelW - BUFFER_W),
    );
    this.camY = Math.round(
      levelH <= BUFFER_H ? (levelH - BUFFER_H) / 2 : clamp(wantY + ky, 0, levelH - BUFFER_H),
    );
  }

  private sx(worldX: number): number {
    return Math.round(worldX - this.camX);
  }

  private sy(worldY: number): number {
    return Math.round(worldY - this.camY);
  }

  /** Light level used to shade a tile, blending current sight with memory. */
  private brightness(game: Game, tx: number, ty: number): number {
    const lit = game.fog.litAt(tx, ty);
    const seen = game.fog.seenAt(tx, ty);
    if (lit <= 0.02 && !seen) return 0;
    return clamp(Math.max(lit, seen ? LIGHT.memoryLevel : 0) + LIGHT.ambient, 0, 1);
  }

  private shade(x: number, y: number, w: number, h: number, b: number): void {
    if (b >= 0.995) return;
    const g = this.bctx;
    g.globalAlpha = 1 - b;
    g.fillStyle = PAL.black;
    g.fillRect(x, y, w, h);
    g.globalAlpha = 1;
  }

  /* ----------------------------------------------------------------- tiles */

  private drawTiles(game: Game): void {
    const g = this.bctx;
    const t0x = Math.floor(this.camX / TILE);
    const t0y = Math.floor(this.camY / TILE);
    const t1x = Math.floor((this.camX + BUFFER_W) / TILE);
    const t1y = Math.floor((this.camY + BUFFER_H) / TILE);

    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        if (!game.level.inBounds(tx, ty)) continue;
        const b = this.brightness(game, tx, ty);
        if (b <= 0) continue;
        const tile = game.level.at(tx, ty);
        if (tile === Tile.Void) continue;

        const variant = game.level.variant[game.level.idx(tx, ty)];
        let sprite: Canvas;
        switch (tile) {
          case Tile.Wall:
            sprite = this.art.walls[variant % this.art.walls.length];
            break;
          case Tile.Grate:
            sprite = this.art.grate;
            break;
          case Tile.Shadow:
            sprite = this.art.shadowFloor;
            break;
          default:
            sprite = this.art.floors[variant % this.art.floors.length];
            break;
        }
        const x = this.sx(tx * TILE);
        const y = this.sy(ty * TILE);
        g.drawImage(sprite, x, y);

        // Contact shadow where a floor meets the wall above it. One dark line
        // per exposed edge is enough to stop the map reading as a flat grid.
        if (tile !== Tile.Wall) {
          if (game.level.blocksSight(tx, ty - 1)) {
            g.globalAlpha = 0.4;
            g.fillStyle = PAL.black;
            g.fillRect(x, y, TILE, 2);
            g.globalAlpha = 0.18;
            g.fillRect(x, y + 2, TILE, 1);
            g.globalAlpha = 1;
          }
          if (game.level.blocksSight(tx - 1, ty)) {
            g.globalAlpha = 0.22;
            g.fillStyle = PAL.black;
            g.fillRect(x, y, 1, TILE);
            g.globalAlpha = 1;
          }
          if (game.level.blocksSight(tx + 1, ty)) {
            g.globalAlpha = 0.22;
            g.fillStyle = PAL.black;
            g.fillRect(x + TILE - 1, y, 1, TILE);
            g.globalAlpha = 1;
          }
        }

        this.shade(x, y, TILE, TILE, b);
      }
    }
  }

  /**
   * Dust in the light. Purely atmospheric, and deliberately anchored to world
   * space so the motes drift past as the camera moves rather than swimming with
   * it. Only drawn where the player can actually see, so it never gives away
   * geometry the fog is hiding.
   */
  private drawDust(game: Game): void {
    const g = this.bctx;
    const t = game.elapsed;
    g.save();
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < 34; i++) {
      // A fixed lattice in world space, each mote on its own slow ellipse.
      const bx = ((i * 977) % 2048) + Math.sin(t * 0.19 + i) * 14;
      const by = ((i * 1583) % 1408) + Math.cos(t * 0.15 + i * 1.7) * 11;
      const wx = this.camX + (((bx - this.camX) % BUFFER_W) + BUFFER_W) % BUFFER_W;
      const wy = this.camY + (((by - this.camY) % BUFFER_H) + BUFFER_H) % BUFFER_H;
      const b = this.brightness(game, Math.floor(wx / TILE), Math.floor(wy / TILE));
      if (b < 0.35) continue;
      const twinkle = 0.5 + 0.5 * Math.sin(t * 1.6 + i * 2.1);
      g.globalAlpha = 0.06 * twinkle * b;
      g.fillStyle = PAL.cyanBright;
      g.fillRect(this.sx(wx), this.sy(wy), 1, 1);
    }
    g.restore();
  }

  /**
   * Puzzle hardware, drawn into the floor.
   *
   * These have to be legible without a word of text: a pad you can stand on, a
   * count of how many bodies it can feel, and an unmistakable change when it is
   * satisfied. The brief's anti-frustration rule is the whole point here — the
   * player should never have to guess what a device wants, only how to give it
   * what it wants.
   */
  private drawPuzzleFloor(game: Game): void {
    const g = this.bctx;

    for (const s of game.puzzles.scanners()) {
      // Lit by the middle of the pad, not its top-left corner — a pad whose
      // corner fell in shadow vanished entirely while you stood on it.
      const b = this.brightness(
        game,
        s.area.x + (s.area.w >> 1),
        s.area.y + (s.area.h >> 1),
      );
      if (b <= 0) continue;
      const x = this.sx(s.area.x * TILE);
      const y = this.sy(s.area.y * TILE);
      const w = s.area.w * TILE;
      const h = s.area.h * TILE;
      const on = s.count >= s.need;
      const a = clamp(b + 0.3, 0, 1);

      // Recessed well, with a lip catching the light along the top and left.
      g.globalAlpha = a * 0.6;
      g.fillStyle = PAL.floorDark;
      g.fillRect(x + 1, y + 1, w - 2, h - 2);
      g.globalAlpha = a * 0.35;
      g.fillStyle = PAL.black;
      g.fillRect(x + 1, y + 1, w - 2, 1);
      g.fillRect(x + 1, y + 1, 1, h - 2);
      g.globalAlpha = a * 0.18;
      g.fillStyle = PAL.wallEdge;
      g.fillRect(x + 1, y + h - 2, w - 2, 1);
      g.globalAlpha = 1;

      // Hatched deck plate, so an empty pad still reads as machinery rather than
      // an empty rectangle drawn on the floor.
      g.globalAlpha = a * 0.16;
      g.fillStyle = on ? PAL.green : PAL.cyanDim;
      for (let hy = y + 3; hy < y + h - 2; hy += 3) g.fillRect(x + 3, hy, w - 6, 1);
      g.globalAlpha = 1;

      // Corner brackets: reads as a machined pad and survives being drawn over
      // the floor's own panel seams.
      g.strokeStyle = alpha(on ? PAL.green : PAL.cyanDim, a * (on ? 0.95 : 0.6));
      g.lineWidth = 1;
      const c = 4;
      for (const [cx, cy, dx, dy] of [
        [x + 1, y + 1, 1, 1],
        [x + w - 1, y + 1, -1, 1],
        [x + 1, y + h - 1, 1, -1],
        [x + w - 1, y + h - 1, -1, -1],
      ]) {
        g.beginPath();
        g.moveTo(cx + dx * c, cy);
        g.lineTo(cx, cy);
        g.lineTo(cx, cy + dy * c);
        g.stroke();
        // Bolt head in each corner.
        g.globalAlpha = a * 0.5;
        g.fillStyle = PAL.wallEdge;
        g.fillRect(cx + dx * 2 - 1, cy + dy * 2 - 1, 1, 1);
        g.globalAlpha = 1;
      }

      // How many signatures it can feel, and how many it wants.
      this.drawPips(x + (w - TILE) / 2, y + h - 4, s.count, s.need, b);

      if (on) {
        // Satisfied: a soft fill plus a sweeping scan bar, so the pad reads as
        // actively holding something rather than merely tinted green.
        g.globalAlpha = a * (0.22 + 0.1 * Math.sin(game.elapsed * 5));
        g.fillStyle = PAL.green;
        g.fillRect(x + 2, y + 2, w - 4, h - 4);
        const sweep = ((game.elapsed * 26) % (h - 4)) | 0;
        g.globalAlpha = a * 0.5;
        g.fillStyle = PAL.white;
        g.fillRect(x + 2, y + 2 + sweep, w - 4, 1);
        g.globalAlpha = 1;
      } else if (s.count > 0) {
        // Partly loaded — something is on it, but not enough.
        g.globalAlpha = a * 0.35;
        g.fillStyle = PAL.cyan;
        g.fillRect(x + 2, y + 2, w - 4, h - 4);
        g.globalAlpha = 1;
      }
    }

    // Containment arch: hard red, so it never reads as somewhere to stand.
    for (const arch of game.puzzles.mimicScanners()) {
      const b = this.brightness(
        game,
        arch.area.x + (arch.area.w >> 1),
        arch.area.y + (arch.area.h >> 1),
      );
      if (b <= 0) continue;
      const x = this.sx(arch.area.x * TILE);
      const y = this.sy(arch.area.y * TILE);
      const w = arch.area.w * TILE;
      const h = arch.area.h * TILE;
      const live = arch.present || arch.remaining > 0;
      const a = clamp(b + 0.3, 0, 1);
      const hue = live ? PAL.green : PAL.red;

      // Two posts and a beam between them, rather than a dashed box. It is the
      // one machine in the wing the player cannot operate themselves, so it
      // wants to read as a checkpoint you walk something *through*.
      g.save();
      g.globalAlpha = a;
      g.fillStyle = alpha(PAL.wall, 0.9);
      g.fillRect(x, y, 2, h);
      g.fillRect(x + w - 2, y, 2, h);
      g.fillStyle = alpha(hue, live ? 0.95 : 0.6);
      // Emitter heads top and bottom of each post.
      for (const py of [y + 2, y + h - 3]) {
        g.fillRect(x, py, 2, 1);
        g.fillRect(x + w - 2, py, 2, 1);
      }

      // The scanning beam: a bar travelling down the gap, brighter when live.
      const t = (game.elapsed * (live ? 34 : 13)) % h;
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = a * (live ? 0.5 : 0.22);
      g.fillStyle = hue;
      g.fillRect(x + 2, y + (t | 0), w - 4, 1);
      g.globalAlpha = a * (live ? 0.14 : 0.06);
      g.fillRect(x + 2, y, w - 4, h);
      g.restore();

      // Field edge, tightening as the reading completes.
      g.globalAlpha = a * (live ? 0.85 : 0.4);
      g.strokeStyle = hue;
      g.setLineDash([3, 3]);
      g.lineDashOffset = -game.elapsed * (live ? 26 : 10);
      g.strokeRect(x + 2.5, y + 0.5, w - 5, h - 1);
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    // Microphones: a small dish that lights while it is holding a reading.
    for (const mic of game.puzzles.sensors()) {
      const b = this.brightness(game, mic.tx, mic.ty);
      if (b <= 0) continue;
      const x = this.sx(mic.tx * TILE);
      const y = this.sy(mic.ty * TILE);
      const live = mic.remaining > 0;
      g.globalAlpha = clamp(b + 0.35, 0, 1);
      g.fillStyle = live ? PAL.green : PAL.greyDark;
      g.fillRect(x + 6, y + 6, 4, 4);
      g.strokeStyle = alpha(live ? PAL.green : PAL.cyanDim, live ? 0.9 : 0.5);
      g.lineWidth = 1;
      // Concentric arcs, expanding while it is hot — it is listening.
      for (let i = 1; i <= 2; i++) {
        const rr = i * 3 + (live ? (game.elapsed * 6) % 3 : 0);
        g.beginPath();
        g.arc(x + 8, y + 8, rr, -0.9, 0.9);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  private drawDoors(game: Game): void {
    const g = this.bctx;
    for (const d of game.level.doors) {
      const b = this.brightness(game, d.tx, d.ty);
      if (b <= 0) continue;
      const frames = d.passageNS ? this.art.doorH : this.art.doorV;
      const frame = frames[Math.min(frames.length - 1, Math.round(d.openness * (frames.length - 1)))];
      const x = this.sx(d.tx * TILE);
      const y = this.sy(d.ty * TILE);
      g.drawImage(frame, x, y);
      this.shade(x, y, TILE, TILE, b);
      // Matching marks on the gate itself, so the pairing is readable from
      // either end without any text.
      const s = game.gateStatus(d);
      if (s) this.drawPips(x, y + TILE - 4, s.held, s.needed, b);
    }
  }

  /* ----------------------------------------------------------------- props */

  private propSprite(p: Prop, t: number): Canvas {
    switch (p.kind) {
      case "plate":
        return this.art.plate[p.active ? 1 : 0];
      case "lever":
        return this.art.lever[p.active ? 1 : 0];
      case "terminal":
        return p.active ? frameAt(this.art.terminalOn, t) : this.art.terminalOff;
      case "console":
        return p.active ? this.art.consoleOn : frameAt(this.art.consoleOff, t);
      case "exit":
        return p.active ? frameAt(this.art.exitOpen, t) : this.art.exitClosed;
      default: {
        const octant = ((Math.round(p.aim / ((Math.PI * 2) / 8)) % 8) + 8) % 8;
        return p.alertT > 0 ? this.art.camera.alert[octant] : this.art.camera.idle[octant];
      }
    }
  }

  private drawProps(game: Game): void {
    const g = this.bctx;
    for (const p of game.level.props) {
      const b = this.brightness(game, p.tx, p.ty);
      if (b <= 0) continue;
      const x = this.sx(p.tx * TILE);
      const y = this.sy(p.ty * TILE);
      g.drawImage(this.propSprite(p, game.elapsed), x, y);
      this.shade(x, y, TILE, TILE, b);
      if (p.kind === "plate") {
        const s = game.plateStatus(p.id);
        if (s) this.drawPips(x, y + TILE - 4, s.held, s.needed, b);
      }
    }
  }

  /**
   * The wiring, made visible. A plate and the gate it feeds carry the same row
   * of marks, and those marks show the *gate's* live state — so standing on one
   * plate tells you how many of its siblings are already held, even though the
   * gate itself is far outside the fog radius.
   */
  private drawPips(x: number, y: number, held: number, needed: number, brightness: number): void {
    const g = this.bctx;
    const w = needed * 3 - 1;
    const startX = Math.round(x + (TILE - w) / 2);
    for (let i = 0; i < needed; i++) {
      g.globalAlpha = clamp(brightness + 0.35, 0, 1);
      g.fillStyle = i < held ? PAL.green : PAL.greyDark;
      g.fillRect(startX + i * 3, y, 2, 2);
    }
    g.globalAlpha = 1;
  }

  /* --------------------------------------------------------------- effects */

  private drawSoundRings(game: Game): void {
    const g = this.bctx;
    for (const s of game.sounds.visible) {
      const life = clamp(s.age / 0.6, 0, 1);
      const radius = s.loudness * TILE * life * 0.55;
      if (radius < 2) continue;
      // A ring for a noise you could not possibly have heard — three rooms away
      // through solid wall — was drawing MIMIC a map of the facility for free.
      // Fade it by how much of the sound actually survives the geometry.
      const b = this.brightness(game, Math.floor(s.x / TILE), Math.floor(s.y / TILE));
      const heard = clamp(s.audible, 0, 1);
      const strength = Math.max(heard, b > 0 ? 0.35 : 0);
      if (strength <= 0.02) continue;
      const color = s.source === "echo" ? PAL.echo : s.source === "player" ? PAL.cyan : PAL.amber;
      g.strokeStyle = alpha(color, 0.45 * (1 - life) * strength);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(this.sx(s.x), this.sy(s.y), radius, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /**
   * MIMIC's cone, shown only where the player can actually see MIMIC.
   *
   * Cast per-ray and drawn as the polygon the light actually reaches, so the
   * cone stops at walls and spills through doorways instead of being painted
   * straight through the facility. It is a threat indicator, and one that lies
   * about where it can see is worse than none.
   */
  private drawVisionCone(game: Game): void {
    const m = game.mimic;
    if (this.brightness(game, Math.floor(m.x / TILE), Math.floor(m.y / TILE)) < ENTITY_VISIBLE) {
      return;
    }
    const g = this.bctx;
    const range = MIMIC_TUNING.visionTiles * TILE;
    const half = MIMIC_TUNING.coneHalfAngle;
    const ox = this.sx(m.x);
    const oy = this.sy(m.y);

    const rays = 26;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= rays; i++) {
      const a = m.facing - half + (2 * half * i) / rays;
      const d = rayDistance(game.level, m.x, m.y, a, range);
      pts.push([ox + Math.cos(a) * d, oy + Math.sin(a) * d]);
    }

    g.save();
    g.globalCompositeOperation = "lighter";
    g.beginPath();
    g.moveTo(ox, oy);
    for (const [px, py] of pts) g.lineTo(px, py);
    g.closePath();

    // Brighter at the eye and fading out with range, so the dangerous part of
    // the cone — arm's reach — reads differently from its far edge.
    const grad = g.createRadialGradient(ox, oy, 0, ox, oy, range);
    const core = m.alerted ? 0.3 : 0.13;
    grad.addColorStop(0, alpha(m.alerted ? PAL.red : PAL.redDeep, core));
    grad.addColorStop(0.55, alpha(m.alerted ? PAL.red : PAL.redDeep, core * 0.45));
    grad.addColorStop(1, alpha(m.alerted ? PAL.red : PAL.redDeep, 0));
    g.fillStyle = grad;
    g.fill();

    // A hairline along the cone's leading edge makes its exact reach readable.
    g.strokeStyle = alpha(m.alerted ? PAL.red : PAL.redDeep, m.alerted ? 0.3 : 0.14);
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  /**
   * Ability tells. Nothing MIMIC does may be invisible — the player has to be
   * able to learn "that animation means it is about to do something".
   */
  private drawAbilityFx(game: Game): void {
    const g = this.bctx;
    g.save();
    g.globalCompositeOperation = "lighter";

    for (const fx of game.mimicFx) {
      const t = clamp(fx.age / fx.life, 0, 1);
      const fade = 1 - t;
      const x = this.sx(fx.x);
      const y = this.sy(fx.y);

      // DOOR CONTROL — a bolt thrown down a line to the door it seals. Hard,
      // short and terminated by a bracket, so it never reads as a soft data
      // link: something just got locked.
      if (fx.kind === "lock") {
        if (fx.toX === undefined || fx.toY === undefined) continue;
        const tx = this.sx(fx.toX);
        const ty = this.sy(fx.toY);
        g.strokeStyle = alpha(PAL.red, fade * 0.8);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(tx, ty);
        g.stroke();
        // The bolt itself, slamming home along the line.
        const k = Math.min(1, t * 2.2);
        g.fillStyle = alpha(PAL.redBright, fade);
        g.fillRect(Math.round(x + (tx - x) * k) - 2, Math.round(y + (ty - y) * k) - 2, 4, 4);
        // Bracket at the door.
        g.strokeStyle = alpha(PAL.redBright, fade * 0.9);
        g.strokeRect(tx - 5, ty - 5, 10, 10);
        continue;
      }

      // INTERCEPT — a wedge from MIMIC toward the chokepoint it has committed
      // to. It points, which is what separates it from a prediction readout.
      if (fx.kind === "intercept") {
        if (fx.toX === undefined || fx.toY === undefined) continue;
        const tx = this.sx(fx.toX);
        const ty = this.sy(fx.toY);
        const a = Math.atan2(ty - y, tx - x);
        const spread = 0.34;
        const reach = Math.hypot(tx - x, ty - y);
        g.fillStyle = alpha(PAL.amber, fade * 0.16);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a - spread) * reach, y + Math.sin(a - spread) * reach);
        g.lineTo(x + Math.cos(a + spread) * reach, y + Math.sin(a + spread) * reach);
        g.closePath();
        g.fill();
        // A marker where it intends to be waiting.
        g.strokeStyle = alpha(PAL.amber, fade * 0.85);
        g.lineWidth = 1;
        g.beginPath();
        g.arc(tx, ty, 3 + (1 - t) * 4, 0, Math.PI * 2);
        g.stroke();
        continue;
      }

      // FACILITY OVERRIDE — the whole system answering at once. Concentric
      // squares rather than rings: this is the building responding, not MIMIC.
      if (fx.kind === "override") {
        for (let i = 0; i < 3; i++) {
          const phase = clamp(t * 1.4 - i * 0.22, 0, 1);
          if (phase <= 0) continue;
          const r = fx.radius * phase;
          g.strokeStyle = alpha(PAL.red, (1 - phase) * 0.55);
          g.lineWidth = i === 0 ? 2 : 1;
          g.strokeRect(x - r, y - r, r * 2, r * 2);
        }
        continue;
      }

      if (fx.kind === "link" || fx.kind === "predict") {
        if (fx.toX === undefined || fx.toY === undefined) continue;
        const tx = this.sx(fx.toX);
        const ty = this.sy(fx.toY);
        g.strokeStyle = alpha(fx.kind === "predict" ? PAL.amber : PAL.red, fade * 0.5);
        g.lineWidth = 1;
        g.setLineDash([3, 4]);
        g.lineDashOffset = -game.elapsed * 26;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(tx, ty);
        g.stroke();
        g.setLineDash([]);
        // A bead running down the line toward the target.
        g.fillStyle = alpha(PAL.white, fade * 0.7);
        g.fillRect(Math.round(x + (tx - x) * t) - 1, Math.round(y + (ty - y) * t) - 1, 2, 2);
        continue;
      }

      const color =
        fx.kind === "surge" ? PAL.amber : fx.kind === "deep" ? PAL.redBright : PAL.red;

      if (fx.kind === "scan") {
        // A sweeping wedge rather than a ring — it is looking, not pulsing.
        const sweep = Math.sin(fx.age * 2.4) * 1.1;
        g.fillStyle = alpha(color, fade * 0.13);
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, fx.radius, sweep - 0.28, sweep + 0.28);
        g.closePath();
        g.fill();
        continue;
      }

      // Expanding wave for deep scan / surge / pulse.
      const rings = fx.kind === "deep" ? 3 : 1;
      for (let i = 0; i < rings; i++) {
        const phase = clamp(t - i * 0.18, 0, 1);
        if (phase <= 0) continue;
        g.strokeStyle = alpha(color, (1 - phase) * 0.5);
        g.lineWidth = fx.kind === "surge" ? 2 : 1;
        g.beginPath();
        g.arc(x, y, fx.radius * phase, 0, Math.PI * 2);
        g.stroke();
      }
    }

    g.restore();
  }

  /* --------------------------------------------------------------- agents */


  private drawEchoes(game: Game): void {
    const g = this.bctx;
    for (const e of game.echoes.echoes) {
      const b = this.brightness(game, Math.floor(e.x / TILE), Math.floor(e.y / TILE));
      if (b < ENTITY_VISIBLE) continue;

      // An ECHO the player never recorded is drawn wrong on purpose: it drops
      // frames, splits its channels and fragments. The player has spent hours
      // learning that clean cyan means "something I did" — this has to read as
      // the same figure and the wrong recording at once.
      const old = isOldEcho(e.rec.id);

      const set = e.moving ? this.art.echo.walk : this.art.echo.idle;
      // Animation is keyed to the recording's own clock, so a replayed walk
      // cycle lands on the same frames it did during the original run.
      const frame = frameAt(set[e.dir], e.tick / TICK_RATE);
      let a = e.phase === "residue" ? 0.55 : 0.9;
      if (e.phase === "disrupted") a = 0.16 + 0.1 * Math.sin(game.elapsed * 18 + e.seed);
      // Faint per-echo flicker so three of them do not read as one object.
      a *= 0.88 + 0.12 * Math.sin(game.elapsed * 5 + e.seed);

      if (old) {
        // Dropped frames: it stutters out of existence for a beat at a time.
        const drop = Math.sin(game.elapsed * 13.7 + e.seed) > 0.82;
        if (drop) continue;
        const jitter = Math.sin(game.elapsed * 31 + e.seed) * 1.6;
        const ex = this.sx(e.x - TILE / 2);
        const ey = this.sy(e.y - TILE / 2);

        g.save();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = clamp(0.28 * b, 0, 1);
        g.drawImage(frame, ex + jitter, ey);
        g.drawImage(frame, ex - jitter, ey);
        g.restore();

        g.globalAlpha = clamp((0.42 + 0.18 * Math.sin(game.elapsed * 5.1)) * b, 0, 1);
        g.drawImage(frame, ex, ey);
        // A torn band across the body, sliding down it.
        const tear = Math.floor(((game.elapsed * 9 + e.seed) % 1) * TILE);
        g.globalAlpha = clamp(0.5 * b, 0, 1);
        g.drawImage(frame, 0, tear, TILE, 2, ex + jitter * 2, ey + tear, TILE, 2);
        g.globalAlpha = 1;
        continue;
      }

      g.globalAlpha = clamp(a * b, 0, 1);
      if (e.sneaking) {
        g.drawImage(
          frame, 0, 2, TILE, TILE - 2,
          this.sx(e.x - TILE / 2), this.sy(e.y - TILE / 2) + 3, TILE, TILE - 3,
        );
      } else {
        g.drawImage(frame, this.sx(e.x - TILE / 2), this.sy(e.y - TILE / 2));
      }
      g.globalAlpha = 1;
    }
  }

  private drawPlayer(game: Game): void {
    const p = game.player;
    const g = this.bctx;

    // Charge tell: a line along the facing showing exactly where the dash lands,
    // so the burst is aimed rather than guessed.
    if (p.charging && p.charge > 0) {
      const v = dirVector(p.dir);
      const reach = p.chargeDistance;
      const pulse = 0.45 + 0.55 * p.charge;
      g.save();
      g.globalCompositeOperation = "lighter";
      g.strokeStyle = alpha(PAL.cyan, 0.3 * pulse);
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(this.sx(p.x), this.sy(p.y));
      g.lineTo(this.sx(p.x + v.x * reach), this.sy(p.y + v.y * reach));
      g.stroke();
      g.setLineDash([]);
      // Landing marker, brighter as the charge fills.
      g.strokeStyle = alpha(PAL.cyanBright, 0.35 + 0.5 * p.charge);
      g.beginPath();
      g.arc(this.sx(p.x + v.x * reach), this.sy(p.y + v.y * reach), 2 + p.charge * 2, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }

    const set = p.moving ? this.art.player.walk : this.art.player.idle;
    const frame = frameAt(set[p.dir], game.elapsed);

    // Motion trail while the burst travels.
    if (p.dashing) {
      const v = dirVector(p.dir);
      g.save();
      for (let i = 1; i <= 3; i++) {
        g.globalAlpha = 0.22 / i;
        g.drawImage(
          frame,
          this.sx(p.x - v.x * i * 5 - TILE / 2),
          this.sy(p.y - v.y * i * 5 - TILE / 2),
        );
      }
      g.restore();
    }

    // Sneaking: the body drops and compresses. Drawn by clipping a pixel off the
    // top and squashing into the remaining height, which reads as a crouch
    // without needing another eight directions of hand-authored sprites.
    if (p.sneaking) {
      g.drawImage(
        frame,
        0,
        2,
        TILE,
        TILE - 2,
        this.sx(p.x - TILE / 2),
        this.sy(p.y - TILE / 2) + 3,
        TILE,
        TILE - 3,
      );
      return;
    }

    g.drawImage(frame, this.sx(p.x - TILE / 2), this.sy(p.y - TILE / 2));
  }

  private drawMimic(game: Game): void {
    const m = game.mimic;
    const b = this.brightness(game, Math.floor(m.x / TILE), Math.floor(m.y / TILE));
    if (b < ENTITY_VISIBLE) return;
    const set = m.alerted ? this.art.mimicShell.alert : this.art.mimicShell.idle;
    const frame = frameAt(set[0], game.elapsed);
    this.bctx.globalAlpha = clamp(b + 0.35, 0, 1);
    this.bctx.drawImage(frame, this.sx(m.x - TILE / 2), this.sy(m.y - TILE / 2));
    this.bctx.globalAlpha = 1;



    // Hesitation: a faint ring that tightens as it makes up its mind. Small and
    // brief, but it is the only feedback the player gets that a decoy worked.
    if (m.confusionT > 0) {
      const g = this.bctx;
      const k = clamp(m.confusionT / 1.2, 0, 1);
      g.save();
      g.globalCompositeOperation = "lighter";
      g.strokeStyle = alpha(PAL.redBright, 0.28 * k);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(this.sx(m.x), this.sy(m.y), 7 + (1 - k) * 5, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }

  /**
   * The eye pass, run after the glows so the bloom cannot swallow it.
   *
   * Drawn along the gaze, not the facing: the eye snaps to a noise and the body
   * swings round after it. The vision cone stays welded to `facing`, so however
   * far the eye has turned it can never imply MIMIC sees somewhere it does not
   * — the gaze is a tell about intent, the cone is the truth about perception.
   */
  private drawMimicEyePass(game: Game): void {
    const m = game.mimic;
    const b = this.brightness(game, Math.floor(m.x / TILE), Math.floor(m.y / TILE));
    if (b < ENTITY_VISIBLE) return;
    this.drawMimicEye(game, m.x, m.y, m.gaze, clamp(b + 0.35, 0, 1));
  }

  /**
   * MIMIC's eye, drawn from the controller's numbers.
   *
   * Four concentric parts — socket, iris, pupil, core — so the two things the
   * player has to be able to read at a glance, aperture and pupil size, are
   * carried by shape rather than by colour alone. That matters: a red eye
   * getting redder is not information anyone can act on, but an iris closing to
   * a pinpoint is.
   */
  private drawMimicEye(
    game: Game,
    x: number,
    y: number,
    gaze: number,
    a: number,
  ): void {
    const v = game.eye.view;
    const g = this.bctx;
    // Flashing is an accessibility dial; when it is turned down the eye stops
    // strobing but keeps every shape change, so nothing becomes unreadable.
    const flash = game.settings.scale("flashing");
    const flicker = 1 - (1 - v.flicker) * flash;
    const glow = clamp(v.glow * flicker, 0, 1);

    // Where the eye sits on the shell, and a small live wander on top.
    //
    // The travel radius was 1.9px on a 16px body, so even a full turn slid the
    // pupil less than four pixels and the snap was invisible in play. 2.8 is
    // most of the room the shell has before the eye reads as falling off it.
    const ang = gaze + v.drift;
    const ex = this.sx(x + Math.cos(ang) * 2.8);
    const ey = this.sy(y - 0.5 + Math.sin(ang) * 2.8);

    const base = v.tint === "cyan" ? PAL.cyan : PAL.red;
    const core = v.tint === "cyan" ? PAL.cyanBright : PAL.redBright;

    g.save();
    g.globalAlpha = a;

    // A DARK pupil in a bright iris, not a bright core on a bright iris.
    //
    // The first version drew a light core inside a light iris, and at the size
    // this actually renders — about eighteen screen pixels — red on red carried
    // no information at all: the fully relaxed eye and the fully locked one were
    // indistinguishable side by side, which made every value the controller
    // computes pointless. Inverting it gives the whole range one continuous
    // read: relaxed is a hollow ring with a wide dark centre, and focusing
    // closes that centre until the eye is a solid burning slit.
    const rx = 3.2;
    // Aperture squashes the eye vertically. Deliberately dramatic, because the
    // silhouette is the only cue that survives with colour removed entirely.
    const ry = rx * (0.2 + 0.8 * v.aperture);

    // Socket: near-black, so the iris has something to be bright against.
    g.fillStyle = alpha(PAL.black, 0.85);
    g.beginPath();
    g.ellipse(ex, ey, rx + 1.2, ry + 1.2, 0, 0, Math.PI * 2);
    g.fill();

    // Iris.
    g.fillStyle = alpha(base, 0.55 + 0.45 * glow);
    g.beginPath();
    g.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    g.fill();

    // Pupil: dark, and it shrinks toward nothing as MIMIC concentrates.
    const pr = rx * 0.78 * v.pupil;
    if (pr > 0.3) {
      g.fillStyle = alpha(PAL.mimicBody, 0.92);
      g.beginPath();
      g.ellipse(ex, ey, pr, Math.min(pr, ry * 0.82), 0, 0, Math.PI * 2);
      g.fill();
    }

    // Hot rim on a focused eye — the "burning" read at full lock.
    if (v.pupil < 0.5) {
      g.strokeStyle = alpha(core, (0.5 - v.pupil) * 1.6 * glow);
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(ex, ey, rx * 0.55, Math.max(0.6, ry * 0.55), 0, 0, Math.PI * 2);
      g.stroke();
    }

    // Confirmed target gets a hard white core — the single frame that says
    // "it has decided it is you".
    if (v.state === "locked" && glow > 0.6) {
      g.fillStyle = alpha(PAL.white, (glow - 0.6) * 2.2);
      g.fillRect(Math.round(ex) - 0.5, Math.round(ey) - 0.5, 1, 1);
    }

    // Scan ring: abilities and the moment of confirmation.
    if (v.ring !== null) {
      const k = v.ring;
      g.globalCompositeOperation = "lighter";
      g.strokeStyle = alpha(base, 0.35 * (1 - k) * flash + 0.1 * (1 - k));
      g.lineWidth = 1;
      g.beginPath();
      g.arc(this.sx(x), this.sy(y), 6 + k * 16, 0, Math.PI * 2);
      g.stroke();
    }

    g.restore();
  }

  /* ---------------------------------------------------------------- glows */

  private addGlow(sprite: Canvas, x: number, y: number, a: number, scale = 1): void {
    if (a <= 0.01) return;
    const g = this.bctx;
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    g.globalAlpha = clamp(a, 0, 1);
    g.drawImage(sprite, this.sx(x) - w / 2, this.sy(y) - h / 2, w, h);
    g.globalAlpha = 1;
  }

  private drawGlows(game: Game): void {
    const g = this.bctx;
    g.save();
    g.globalCompositeOperation = "lighter";

    // Creeping dims the player's own light. Cyan is the game's word for "you",
    // so turning it down is the most direct way to say "harder to notice".
    const lit = game.player.sneaking ? 0.16 : 0.32;
    this.addGlow(this.art.glowCyan, game.player.x, game.player.y, lit, game.player.sneaking ? 0.6 : 0.75);

    const m = game.mimic;
    if (this.brightness(game, Math.floor(m.x / TILE), Math.floor(m.y / TILE)) >= ENTITY_VISIBLE) {
      // The eye snaps wide on the frame it confirms you — the tell that the
      // RETRACE link just went down.
      const focus = m.focusPulse;
      // System power is never a bar. It is how bright and how steady the eye is:
      // full and stable when charged, dim and guttering when spent. An observant
      // player can read whether MIMIC can currently afford to do anything.
      const power = game.abilities.powerFraction;
      const guttering =
        power < POWER.lowFraction ? 0.55 + 0.45 * Math.sin(game.elapsed * 21) : 1;
      const charge = (0.45 + 0.55 * power) * guttering * (1 - game.abilities.drain * 0.4);

      this.addGlow(
        this.art.glowRed,
        m.x,
        m.y,
        // Pulled down from 0.5/0.28. The glow is atmosphere; at the old level
        // it was the only thing you could see of MIMIC at all.
        (m.alerted ? 0.34 : 0.18) * charge + focus * 0.32,
        (m.alerted ? 0.9 : 0.7) * (0.7 + 0.3 * power) + focus * 0.8,
      );
    }

    for (const e of game.echoes.echoes) {
      if (this.brightness(game, Math.floor(e.x / TILE), Math.floor(e.y / TILE)) < ENTITY_VISIBLE) {
        continue;
      }
      this.addGlow(this.art.glowCyan, e.x, e.y, e.phase === "disrupted" ? 0.08 : 0.2, 0.55);
    }

    for (const p of game.level.props) {
      const b = this.brightness(game, p.tx, p.ty);
      if (b <= 0) continue;
      const cx = p.tx * TILE + TILE / 2;
      const cy = p.ty * TILE + TILE / 2;
      if (p.kind === "plate" && p.active) {
        this.addGlow(this.art.glowGreen, cx, cy, 0.3, 0.5);
      } else if (p.kind === "camera" && p.alertT > 0) {
        this.addGlow(this.art.glowRed, cx, cy, 0.3, 0.5);
      } else if (p.kind === "exit") {
        this.addGlow(p.active ? this.art.glowGreen : this.art.glowAmber, cx, cy, p.active ? 0.45 : 0.14, 1.1);
      } else if (p.active) {
        this.addGlow(this.art.glowAmber, cx, cy, 0.28, 0.55);
      }
    }

    for (const d of game.level.doors) {
      if (d.openness <= 0.05) continue;
      const b = this.brightness(game, d.tx, d.ty);
      if (b <= 0) continue;
      this.addGlow(
        this.art.glowCyan,
        d.tx * TILE + TILE / 2,
        d.ty * TILE + TILE / 2,
        0.16 * d.openness,
        0.5,
      );
    }

    g.restore();
  }

  /* ------------------------------------------------------------------ blit */

  private blit(out: Ctx, game: Game): void {
    out.imageSmoothingEnabled = false;
    out.globalCompositeOperation = "source-over";
    out.globalAlpha = 1;
    out.fillStyle = PAL.void;
    out.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    const corruption =
      clamp(game.glitch * 0.55 + game.glitchPulse, 0, 1) * game.settings.scale("glitch");
    // Vertical tear: the whole frame is drawn in bands that slip sideways.
    if (corruption > 0.25) {
      const bands = 8;
      const bandH = Math.ceil(BUFFER_H / bands);
      for (let i = 0; i < bands; i++) {
        const srcY = i * bandH;
        // The last band is clipped so the source rect never leaves the buffer.
        const srcH = Math.min(bandH, BUFFER_H - srcY);
        if (srcH <= 0) break;
        const wobble = Math.sin(game.elapsed * 21 + i * 2.3) * corruption * 5;
        const shift = Math.round(wobble) * CAMERA_SCALE;
        out.drawImage(
          this.buf,
          0,
          srcY,
          BUFFER_W,
          srcH,
          shift,
          srcY * CAMERA_SCALE,
          DISPLAY_W,
          srcH * CAMERA_SCALE,
        );
      }
    } else {
      out.drawImage(this.buf, 0, 0, BUFFER_W, BUFFER_H, 0, 0, DISPLAY_W, DISPLAY_H);
    }

    if (corruption > 0.02) this.drawCorruption(out, game, corruption);
    this.drawRetraceFold(out, game);
    this.drawEmergency(out, game);
  }

  /**
   * The RETRACE fold.
   *
   * The game is named after this, so it gets a real moment rather than a cut.
   * Three things happen at once and all of them decay inside a second: a
   * cyan-white bloom from the centre, horizontal streaks that smear *backward*
   * (the frame being pulled into the past), and a scanline tear sweeping up the
   * screen. No zoom and no camera roll — those make people queasy on a move
   * they will perform hundreds of times.
   */
  private drawRetraceFold(out: Ctx, game: Game): void {
    const f = clamp(game.retraceFlash, 0, 1);
    if (f <= 0.01) return;
    // Sharp attack, long tail: it hits and then lets go.
    const bloom = f * f;

    out.save();

    // Reversed smear. Copies of the frame trail off to one side, brightest
    // nearest the present.
    out.globalCompositeOperation = "lighter";
    for (let i = 1; i <= 4; i++) {
      out.globalAlpha = 0.16 * bloom * (1 - i / 5);
      out.drawImage(this.buf, i * 9 * bloom, 0, DISPLAY_W, DISPLAY_H);
    }
    out.restore();

    out.save();
    // Central bloom, cyan at the edge and white at the core.
    const grad = out.createRadialGradient(
      DISPLAY_W / 2,
      DISPLAY_H / 2,
      0,
      DISPLAY_W / 2,
      DISPLAY_H / 2,
      Math.max(DISPLAY_W, DISPLAY_H) * 0.62,
    );
    grad.addColorStop(0, alpha(PAL.white, 0.55 * bloom));
    grad.addColorStop(0.35, alpha(PAL.cyanBright, 0.32 * bloom));
    grad.addColorStop(1, alpha(PAL.cyan, 0));
    out.fillStyle = grad;
    out.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    // A tear sweeping up the frame, so the fold has a direction.
    const tearY = Math.round((1 - f) * DISPLAY_H);
    const tearH = Math.max(2, Math.round(26 * bloom));
    out.globalAlpha = 0.5 * bloom;
    out.fillStyle = PAL.cyanBright;
    out.fillRect(0, tearY, DISPLAY_W, 1);
    out.globalAlpha = 0.22 * bloom;
    out.drawImage(
      this.buf,
      0,
      Math.max(0, Math.floor(tearY / CAMERA_SCALE)),
      BUFFER_W,
      Math.max(1, Math.floor(tearH / CAMERA_SCALE)),
      Math.round(14 * bloom),
      tearY,
      DISPLAY_W,
      tearH,
    );
    out.restore();
  }

  /**
   * Facility emergency lighting. A slow red swell from the screen edges rather
   * than a strobe — it has to read instantly at a glance without becoming a
   * flashing hazard, and the AlertManager flattens it further under
   * prefers-reduced-motion.
   */
  private drawEmergency(out: Ctx, game: Game): void {
    // Scaled, never removed: the emergency wash is how the world says HUNT.
    // Turning flashing off dims the pulse rather than deleting the signal, and
    // the announcement, log line, music and MIMIC behaviour all still fire.
    const flash = game.settings.scale("flashing");
    const level = game.alert.emergency * (0.35 + 0.65 * flash);
    if (level <= 0.01) return;

    const pulse = game.alert.strobe * flash;
    out.save();
    const grad = out.createRadialGradient(
      DISPLAY_W / 2,
      DISPLAY_H / 2,
      Math.min(DISPLAY_W, DISPLAY_H) * 0.22,
      DISPLAY_W / 2,
      DISPLAY_H / 2,
      Math.max(DISPLAY_W, DISPLAY_H) * 0.72,
    );
    grad.addColorStop(0, alpha(PAL.red, 0));
    grad.addColorStop(1, alpha(PAL.red, 0.16 + pulse * 0.3));
    out.fillStyle = grad;
    out.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    // Warning bars top and bottom — the panels along the corridor coming on.
    out.globalAlpha = 0.25 + pulse * 0.45;
    out.fillStyle = PAL.red;
    out.fillRect(0, 0, DISPLAY_W, 3);
    out.fillRect(0, DISPLAY_H - 3, DISPLAY_W, 3);
    out.restore();
  }

  /** Channel split, scanlines and static — intensity ramps with each capture. */
  private drawCorruption(out: Ctx, game: Game, corruption: number): void {
    const offset = Math.round(1 + corruption * 5) * CAMERA_SCALE;

    out.save();
    out.globalCompositeOperation = "lighter";
    out.globalAlpha = 0.16 + corruption * 0.28;
    out.drawImage(this.buf, -offset, 0, DISPLAY_W, DISPLAY_H);
    out.drawImage(this.buf, offset, 0, DISPLAY_W, DISPLAY_H);
    out.restore();

    out.save();
    out.globalAlpha = 0.05 + corruption * 0.12;
    out.fillStyle = PAL.black;
    for (let y = 0; y < DISPLAY_H; y += CAMERA_SCALE * 2) {
      out.fillRect(0, y, DISPLAY_W, CAMERA_SCALE);
    }
    out.restore();

    // Deterministic static blocks — seeded off the frame so they crawl.
    const blocks = Math.floor(corruption * 26);
    let s = (Math.floor(game.elapsed * 30) * 2654435761) >>> 0;
    out.save();
    for (let i = 0; i < blocks; i++) {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      const x = (s >>> 8) % DISPLAY_W;
      const y = (s >>> 3) % DISPLAY_H;
      const w = 20 + ((s >>> 17) % 140);
      const h = CAMERA_SCALE * (1 + ((s >>> 11) % 3));
      out.globalAlpha = 0.06 + corruption * 0.2;
      out.fillStyle = i % 3 === 0 ? PAL.red : i % 3 === 1 ? PAL.cyan : PAL.white;
      out.fillRect(x, y, w, h);
    }
    out.restore();

    if (game.phase === "collapse") {
      out.save();
      out.globalAlpha = clamp(1 - game.freezeT / 3, 0, 1) * 0.9;
      out.fillStyle = PAL.black;
      out.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
      out.restore();
    }
  }
}
