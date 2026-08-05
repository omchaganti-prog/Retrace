/**
 * How the story looks.
 *
 * Everything here is text on a dark rectangle, because that is what a 2D game
 * built out of 16px tiles can do beautifully and a cinematic cannot. The
 * facility talks in monospace; the reveals are readouts. Committing to that is
 * cheaper *and* better than faking cutscenes — the medium becomes the voice.
 */
import {
  ENDING,
  ENDING_SECONDS,
  type OpeningLine,
  OPENING,
  OPENING_SECONDS,
} from "../story/content";
import type { Game } from "../game/game";
import { DISPLAY_H, DISPLAY_W } from "./renderer";
import { PAL, alpha } from "./palette";
import type { Ctx } from "./pixels";

const MONO = '"Consolas", "DejaVu Sans Mono", monospace';

function line(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  a = 1,
): void {
  ctx.font = `${size}px ${MONO}`;
  ctx.fillStyle = color;
  ctx.globalAlpha = a;
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

/**
 * Draws a timed text sequence — used by both the opening and the ending.
 *
 * Lines accumulate rather than replacing each other, so the screen fills the way
 * a boot log does. A glitched line is drawn three times in offset channels,
 * which reads as corruption without needing a shader.
 */
function sequence(ctx: Ctx, lines: OpeningLine[], t: number, seed: number): void {
  ctx.save();
  ctx.textAlign = "center";
  const cx = DISPLAY_W / 2;
  let y = DISPLAY_H / 2 - 90;

  for (const l of lines) {
    if (t < l.at) break;
    const age = t - l.at;
    const fade = Math.min(1, age / 0.35);
    const size = l.large ? 26 : 15;
    y += l.large ? 40 : 24;

    if (l.glitch) {
      // Split the channels and jitter them. The line is legible but wrong.
      const j = Math.sin(seed + age * 44) * 3;
      line(ctx, l.text, cx + j, y, size, PAL.red, 0.55 * fade);
      line(ctx, l.text, cx - j, y, size, PAL.cyan, 0.55 * fade);
      line(ctx, l.text, cx, y, size, PAL.white, 0.9 * fade);
    } else {
      line(ctx, l.text, cx, y, size, l.large ? PAL.cyan : PAL.grey, fade);
    }
  }
  ctx.restore();
}

/** The boot sequence. Returns true while it still owns the screen. */
export function drawOpening(ctx: Ctx, game: Game): boolean {
  const t = game.openingT;
  if (t >= OPENING_SECONDS) return false;

  // Lights come up over the last second and a half, revealing the room under
  // the text rather than cutting to it.
  const reveal = Math.max(0, Math.min(1, (t - (OPENING_SECONDS - 1.6)) / 1.6));
  ctx.save();
  ctx.globalAlpha = 1 - reveal;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.restore();

  sequence(ctx, OPENING, t, 11.3);

  if (t > 2 && game.openingSkippable) {
    ctx.save();
    ctx.textAlign = "right";
    line(ctx, "[ESC] SKIP", DISPLAY_W - 16, DISPLAY_H - 16, 11, PAL.greyDark, 0.7 * (1 - reveal));
    ctx.restore();
  }
  return true;
}

/**
 * The ending.
 *
 * Runs once Subject 047 crosses the threshold. The facility signs off in its own
 * voice — a status line, a project termination, and then the one number it has
 * been quietly keeping the whole game. `MIMIC LEARNING: 100%` is the only line
 * here that is a twist, and it is delivered as a readout like everything else,
 * because the facility has never once editorialised and should not start now.
 *
 * Returns true while it owns the screen, so the stats card waits its turn.
 */
export function drawEnding(ctx: Ctx, game: Game): boolean {
  if (game.phase !== "escaped") return false;
  const t = game.endingT;
  if (t >= ENDING_SECONDS) return false;

  // The world dims out over the first couple of seconds rather than cutting, so
  // the last thing on screen is the corridor you just left.
  const fade = Math.min(1, t / 2.2);
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.restore();

  sequence(ctx, ENDING, t, 4.7);
  return true;
}

/**
 * A terminal the player is reading.
 *
 * Deliberately a small panel rather than a full-screen takeover: the room stays
 * visible around it, so reading never feels like leaving the game. The brief was
 * explicit about not burying the player in walls of text.
 */
export function drawTerminal(ctx: Ctx, game: Game): void {
  const t = game.story.terminal;
  if (!t) return;

  const lines = game.terminalLines();
  const w = 380;
  const h = Math.max(140, 76 + lines.length * 17);
  const x = Math.round((DISPLAY_W - w) / 2);
  const y = Math.round((DISPLAY_H - h) / 2);

  ctx.save();
  // Dim the world without hiding it.
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.globalAlpha = 1;

  ctx.fillStyle = alpha(PAL.floorDark, 0.97);
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.cyanDim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // Scanlines, so it reads as a screen rather than a dialog box.
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = PAL.black;
  for (let sy = y + 2; sy < y + h - 2; sy += 3) ctx.fillRect(x + 1, sy, w - 2, 1);
  ctx.globalAlpha = 1;

  ctx.textAlign = "left";
  const glitching = game.story.trialGlitchActive;
  line(ctx, t.title, x + 18, y + 30, 14, glitching ? PAL.red : PAL.cyan);
  ctx.fillStyle = PAL.cyanDeep;
  ctx.fillRect(x + 18, y + 38, w - 36, 1);

  let ly = y + 60;
  for (const l of lines) {
    if (l) line(ctx, l, x + 18, ly, 12, glitching ? PAL.redBright : PAL.grey);
    ly += 17;
  }

  ctx.textAlign = "right";
  line(ctx, "[E] CLOSE", x + w - 18, y + h - 14, 10, PAL.greyDark);
  ctx.restore();
}

/** Facility announcements and MIMIC's rare lines, along the top of the screen. */
export function drawAnnouncement(ctx: Ctx, game: Game): void {
  const a = game.story.announcement;
  const m = game.story.mimicLine;
  ctx.save();
  ctx.textAlign = "center";

  if (a) {
    const fade = Math.min(1, a.t / 0.5);
    const color = a.tone === "warn" ? PAL.red : a.tone === "corrupt" ? PAL.redBright : PAL.grey;
    line(ctx, a.text, DISPLAY_W / 2, 34, 13, color, 0.9 * fade);
  }

  // MIMIC gets its own place on screen and its own colour. When one of these
  // appears it must not read as another facility notice.
  if (m) {
    const fade = Math.min(1, m.t / 0.5);
    const pulse = 0.8 + 0.2 * Math.sin(game.elapsed * 6);
    line(ctx, m.text, DISPLAY_W / 2, DISPLAY_H - 76, 15, PAL.red, fade * pulse);
  }
  ctx.restore();
}
