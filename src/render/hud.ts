/**
 * HUD.
 *
 * Drawn at display resolution rather than into the pixel buffer, so text stays
 * legible at any scale. Deliberately sparse: no health bar and no life counter.
 * Temporal Stability is only ever expressed as a status line that corrupts as it
 * drops — you are meant to work out what it means by losing it.
 */
import { ABILITY_TUNING, POWER } from "../ai/abilities";
import { ADAPTATION_LABEL } from "../ai/adaptation";
import {
  DASH,
  type ObjectiveId,
  REQUIRED_OBJECTIVES,
  STABILITY,
  STAMINA,
  TILE,
} from "../core/constants";
import { clamp } from "../core/math";
import { ENDING_SECONDS } from "../story/content";
import type { Game, LogTone } from "../game/game";
import type { LinkState } from "../systems/strategist";
import { DISPLAY_H, DISPLAY_W } from "./renderer";
import { PAL, alpha } from "./palette";
import type { Ctx } from "./pixels";

const FONT = '"Consolas", "DejaVu Sans Mono", monospace';
const GARBLE = "!@#$%&*<>/\\|=+_?§±¶█▓▒░";

/** Every gated system, in the order the HUD lists them. */
// Only what the lift waits on. Optional systems stay out of the checklist so
// it reads as a route, not a chore list.
const CORE_OBJECTIVES: ObjectiveId[] = [...REQUIRED_OBJECTIVES];

const OBJECTIVE_LABELS: Record<string, string> = {
  intake: "GENERATOR INTAKE",
  power: "REACTOR POWER",
  cascade: "GENERATOR CASCADE",
  auth: "SECURITY AUTHORIZATION",
  bypass: "TEMPORAL BYPASS",
  clearance: "CONTAINMENT CLEARANCE",
  containment: "CONTAINMENT OVERRIDE",
  escape: "SURFACE LIFT",
};

/** Any live remote planner reads as amber; the local fallback stays grey. */
const LINK_DISPLAY: Record<LinkState, { label: string; color: string }> = {
  local: { label: "LOCAL", color: PAL.grey },
  pending: { label: "SYNC...", color: PAL.cyanDim },
  claude: { label: "CLAUDE", color: PAL.amber },
  openai: { label: "GPT", color: PAL.amber },
};

const TONE_COLOR: Record<LogTone, string> = {
  info: PAL.grey,
  warn: PAL.red,
  good: PAL.green,
};

interface TextOpts {
  size?: number;
  color?: string;
  a?: number;
  align?: CanvasTextAlign;
  bold?: boolean;
}

function text(ctx: Ctx, str: string, x: number, y: number, o: TextOpts = {}): void {
  const size = o.size ?? 13;
  ctx.font = `${o.bold ? "bold " : ""}${size}px ${FONT}`;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = o.a ?? 1;
  ctx.fillStyle = o.color ?? PAL.white;
  ctx.fillText(str, x, y);
  ctx.globalAlpha = 1;
}

/** Replace a fraction of the characters with noise glyphs. */
function garble(str: string, amount: number, seed: number): string {
  if (amount <= 0) return str;
  let s = seed >>> 0;
  let out = "";
  for (const ch of str) {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    const roll = (s >>> 8) / 0x1000000;
    out += ch !== " " && roll < amount ? GARBLE[(s >>> 3) % GARBLE.length] : ch;
  }
  return out;
}

export function drawHud(ctx: Ctx, game: Game): void {
  ctx.save();
  drawObjectives(ctx, game);
  drawLink(ctx, game);
  drawEchoes(ctx, game);
  drawStamina(ctx, game);
  drawStability(ctx, game);
  drawStatusLine(ctx, game);
  drawPrompt(ctx, game);
  drawRetraceMeter(ctx, game);
  drawSchematic(ctx, game);
  drawSoundArrows(ctx, game);
  drawAnnouncement(ctx, game);
  drawNotice(ctx, game);
  drawLog(ctx, game);
  if (game.debug) drawDebug(ctx, game);
  drawEndCards(ctx, game);
  ctx.restore();
}

/* --------------------------------------------------------------- top left */

function drawObjectives(ctx: Ctx, game: Game): void {
  const x = 22;
  let y = 34;
  text(ctx, game.level.name, x, y, { size: 12, color: PAL.cyanDim, a: 0.85 });
  y += 22;

  for (const id of CORE_OBJECTIVES) {
    const done = game.objectives.has(id);
    const next = !done && game.nextObjective === id;
    text(ctx, done ? "[+]" : next ? "[>]" : "[ ]", x, y, {
      size: 12,
      color: done ? PAL.green : next ? PAL.amber : PAL.greyDark,
    });
    text(ctx, OBJECTIVE_LABELS[id], x + 30, y, {
      size: 12,
      color: done ? PAL.green : next ? PAL.white : PAL.greyDark,
      a: done ? 0.8 : 1,
    });
    y += 17;
  }

  const open = game.lockdown;
  text(ctx, open ? "[>]" : "[ ]", x, y, { size: 12, color: open ? PAL.amber : PAL.greyDark });
  text(ctx, OBJECTIVE_LABELS.escape, x + 30, y, {
    size: 12,
    color: open ? PAL.amber : PAL.greyDark,
  });
}

/* -------------------------------------------------------------- top right */

function drawLink(ctx: Ctx, game: Game): void {
  const x = DISPLAY_W - 22;
  const { label, color } = LINK_DISPLAY[game.strategist.link];

  text(ctx, `MIMIC LINK: ${label}`, x, 34, { size: 12, color, align: "right" });

  const knowledge = game.memory.knowledge();
  text(ctx, `KNOWLEDGE ${String(knowledge).padStart(3, " ")}%`, x, 53, {
    size: 12,
    color: knowledge > 60 ? PAL.red : PAL.grey,
    align: "right",
  });

  // Knowledge bar.
  const barW = 128;
  const barX = x - barW;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = PAL.greyDark;
  ctx.fillRect(barX, 60, barW, 3);
  ctx.globalAlpha = 1;
  ctx.fillStyle = knowledge > 60 ? PAL.red : PAL.cyanDim;
  ctx.fillRect(barX, 60, (barW * knowledge) / 100, 3);

  text(ctx, `RUN ${game.run}  ${game.runTime.toFixed(0)}s`, x, 82, {
    size: 11,
    color: PAL.greyDark,
    align: "right",
  });
  if (game.strategist.current.rationale) {
    text(ctx, game.strategist.current.rationale, x, 99, {
      size: 10,
      color: PAL.greyDark,
      a: 0.75,
      align: "right",
    });
  }
}

/* ----------------------------------------------------------- bottom left */

/**
 * Bottom-left stack, bottom upward. Fixed rows rather than a flow layout so an
 * indicator appearing or vanishing never shifts the ones below it.
 */
const BL_X = 22;
const ECHO_PIP_Y = DISPLAY_H - 38;
const ECHO_LABEL_Y = DISPLAY_H - 56;
const STAMINA_BAR_Y = DISPLAY_H - 78;
const STAMINA_LABEL_Y = DISPLAY_H - 86;
const STABILITY_BAR_Y = DISPLAY_H - 104;
const STABILITY_LABEL_Y = DISPLAY_H - 118;

function drawEchoes(ctx: Ctx, game: Game): void {
  const x = BL_X;
  const y = ECHO_PIP_Y + 4;
  text(ctx, "ECHOES", x, ECHO_LABEL_Y, { size: 11, color: PAL.greyDark });

  for (let i = 0; i < 3; i++) {
    const echo = game.echoes.echoes[i];
    const cx = x + 9 + i * 24;
    ctx.beginPath();
    ctx.arc(cx, y - 4, 7, 0, Math.PI * 2);
    if (echo) {
      ctx.fillStyle = echo.phase === "disrupted" ? PAL.echoDim : PAL.echo;
      ctx.globalAlpha = echo.phase === "residue" ? 0.55 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      // Progress ring: how far through its recording this ECHO is.
      ctx.beginPath();
      ctx.arc(cx, y - 4, 10, -Math.PI / 2, -Math.PI / 2 + echo.progress * Math.PI * 2);
      ctx.strokeStyle = alpha(PAL.echo, 0.7);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.strokeStyle = PAL.greyDark;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

/**
 * Sprint meter. Hidden while full, because a permanently-visible bar for a
 * resource you are not using is exactly the clutter the brief warns against.
 */
/**
 * Temporal energy, as cells rather than a bar.
 *
 * A continuous bar reads as an RPG resource. Discrete cells read as charge in a
 * device — and, more usefully, they are countable at a glance: you can see you
 * have two dashes left without doing arithmetic on a rectangle. The partial cell
 * at the head is the only continuous part, so regeneration still feels smooth.
 */
function drawStamina(ctx: Ctx, game: Game): void {
  const p = game.player;
  const frac = p.staminaFraction;
  const low = p.stamina < STAMINA.lowAt;

  // Hidden when full and idle. A meter for a resource you are not spending is
  // exactly the clutter a minimal HUD is supposed to avoid.
  if (frac >= 0.999 && !p.exhausted && !p.charging) return;

  const cells = 10;
  const cw = 8;
  const gap = 2;
  const h = 5;
  const filled = frac * cells;
  const breath = low ? 0.62 + 0.38 * Math.sin(game.elapsed * (p.exhausted ? 7 : 4.2)) : 1;
  const color = p.exhausted ? PAL.red : low ? PAL.cyanBright : PAL.cyan;

  text(ctx, p.exhausted ? "TEMPORAL ENERGY // DEPLETED" : "TEMPORAL ENERGY", BL_X, STAMINA_LABEL_Y, {
    size: 10,
    color: p.exhausted ? PAL.red : low ? PAL.cyan : PAL.greyDark,
    a: low ? breath : 0.75,
  });

  // What the pending dash would spend, so the cost is visible before committing.
  const costCells = p.charging ? (p.chargeCost / STAMINA.max) * cells : 0;
  const spendFrom = Math.max(0, filled - costCells);

  for (let i = 0; i < cells; i++) {
    const x = BL_X + i * (cw + gap);
    const fill = clamp(filled - i, 0, 1);

    // Empty socket.
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = PAL.greyDark;
    ctx.fillRect(x, STAMINA_BAR_Y, cw, h);
    ctx.globalAlpha = 1;

    if (fill > 0) {
      // Cells about to be spent by the charge flash rather than sit still.
      const doomed = p.charging && i + 1 > spendFrom;
      ctx.globalAlpha = (low ? breath : 1) * (doomed ? 0.45 + 0.55 * Math.sin(game.elapsed * 18) : 1);
      ctx.fillStyle = doomed ? PAL.cyanBright : color;
      ctx.fillRect(x, STAMINA_BAR_Y, Math.max(1, Math.round(cw * fill)), h);
      ctx.globalAlpha = 1;
    }
  }

  // The level sprinting unlocks again after a full drain, marked on the sockets.
  if (p.exhausted) {
    const unlockX = BL_X + (STAMINA.unlockAt / STAMINA.max) * cells * (cw + gap);
    ctx.fillStyle = PAL.redBright;
    ctx.fillRect(Math.round(unlockX), STAMINA_BAR_Y - 2, 1, h + 4);
  }
}

function drawStability(ctx: Ctx, game: Game): void {
  const lost = STABILITY.max - game.stability;
  if (lost <= 0) return;
  // Never a number. The readout degrades, and that is the only tell.
  const amount = lost / STABILITY.max;
  const seed = Math.floor(game.elapsed * 8);
  const label = garble("TEMPORAL STABILITY", amount * 0.55, seed);
  const bars = garble("=".repeat(game.stability * 6), amount * 0.7, seed + 11);
  text(ctx, label, BL_X, STABILITY_LABEL_Y, {
    size: 11,
    color: PAL.red,
    a: 0.5 + 0.35 * Math.sin(game.elapsed * 3),
  });
  text(ctx, bars, BL_X, STABILITY_BAR_Y, { size: 11, color: PAL.redDeep });
}

/* --------------------------------------------------------- bottom centre */

/**
 * Names whatever the player is standing on. Plates are not interactable, so
 * they get a plain readout rather than an [E] prompt — and it reports the gate's
 * progress, which is the part that is otherwise impossible to observe.
 */
function drawStatusLine(ctx: Ctx, game: Game): void {
  if (game.phase !== "playing") return;

  if (game.statusLine) {
    text(ctx, game.statusLine, DISPLAY_W / 2, DISPLAY_H - 116, {
      size: 12,
      color: PAL.cyanDim,
      align: "center",
    });
  }

  // The nudge sits under the state, in brighter cyan, so the two never compete.
  // One says what is happening; this says what would help.
  const hint = game.hint;
  if (hint) {
    text(ctx, hint.text, DISPLAY_W / 2, DISPLAY_H - 98, {
      size: 12,
      color: PAL.cyan,
      align: "center",
      a: clamp(hint.t / 0.8, 0, 1) * 0.95,
    });
  }
}

/** The facility's own wiring diagram, held on screen after using the terminal. */
function drawSchematic(ctx: Ctx, game: Game): void {
  const s = game.schematic;
  if (!s) return;
  const fade = clamp(s.t / 1.2, 0, 1);
  const w = 460;
  const h = 34 + s.lines.length * 18;
  const x = DISPLAY_W / 2 - w / 2;
  const y = DISPLAY_H / 2 - h / 2;

  ctx.save();
  ctx.globalAlpha = fade * 0.88;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = fade * 0.7;
  ctx.strokeStyle = PAL.cyanDim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();

  text(ctx, "FACILITY SCHEMATIC // WING-01", x + 16, y + 22, {
    size: 12,
    color: PAL.amber,
    a: fade,
  });
  s.lines.forEach((line, i) => {
    text(ctx, line, x + 16, y + 44 + i * 18, { size: 12, color: PAL.white, a: fade * 0.9 });
  });
}

function drawPrompt(ctx: Ctx, game: Game): void {
  if (game.phase !== "playing") return;
  const p = game.focusProp;
  if (!p?.label) return;

  const label = game.focusBlocked ? `${p.label} // LOCKED` : `[E]  ${p.label}`;
  const color = game.focusBlocked ? PAL.red : PAL.cyanBright;
  const cx = DISPLAY_W / 2;
  const y = DISPLAY_H - 92;

  ctx.font = `13px ${FONT}`;
  const w = ctx.measureText(label).width + 26;
  ctx.globalAlpha = 0.65;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(cx - w / 2, y - 18, w, 26);
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w / 2, y - 18, w, 26);
  ctx.globalAlpha = 1;

  text(ctx, label, cx, y, { size: 13, color, align: "center" });
}

function drawRetraceMeter(ctx: Ctx, game: Game): void {
  const cx = DISPLAY_W / 2;
  const cy = DISPLAY_H - 150;

  // Refused attempt: a broken ring that fails to close, instead of a silent
  // no-op that reads as an unresponsive key.
  if (game.jamBuzz > 0) {
    const buzz = clamp(game.jamBuzz, 0, 1);
    ctx.save();
    ctx.strokeStyle = alpha(PAL.red, 0.35 + 0.45 * buzz);
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const jitter = Math.sin(game.elapsed * 40 + i * 1.7) * 0.35 * buzz;
      const from = (i / 5) * Math.PI * 2 + jitter;
      ctx.beginPath();
      ctx.arc(cx, cy, 26, from, from + 0.55);
      ctx.stroke();
    }
    ctx.restore();
    text(ctx, garble("SIGNAL JAMMED", 0.3 * buzz, Math.floor(game.elapsed * 30)), cx, cy + 46, {
      size: 11,
      color: PAL.red,
      align: "center",
    });
    return;
  }

  const t = game.retraceProgress;
  if (t <= 0) return;

  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.strokeStyle = alpha(PAL.cyanDeep, 0.8);
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
  ctx.strokeStyle = t >= 1 ? PAL.white : PAL.cyan;
  ctx.lineWidth = 4;
  ctx.stroke();

  text(ctx, "RETRACE", cx, cy + 46, { size: 11, color: PAL.cyan, align: "center" });
  if (game.echoes.atCapacity) {
    text(ctx, "OLDEST ECHO WILL DISSOLVE", cx, cy + 62, {
      size: 10,
      color: PAL.amber,
      align: "center",
      a: 0.85,
    });
  }
}

/* ------------------------------------------------------------ sound cues */

/**
 * Edge arrows for noises the player cannot see the source of — the audio half of
 * knowing where MIMIC is.
 */
function drawSoundArrows(ctx: Ctx, game: Game): void {
  const px = game.player.x;
  const py = game.player.y;

  for (const s of game.sounds.visible) {
    const dx = s.x - px;
    const dy = s.y - py;
    const d = Math.hypot(dx, dy);
    if (d < TILE * 3) continue;
    if (d > s.loudness * TILE * 1.4) continue;

    const tx = Math.floor(s.x / TILE);
    const ty = Math.floor(s.y / TILE);
    if (game.fog.litAt(tx, ty) > 0.2) continue;

    const ang = Math.atan2(dy, dx);
    const rx = DISPLAY_W * 0.36;
    const ry = DISPLAY_H * 0.36;
    const cx = DISPLAY_W / 2 + Math.cos(ang) * rx;
    const cy = DISPLAY_H / 2 + Math.sin(ang) * ry;
    const fade = clamp(1 - s.age / 0.6, 0, 1);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.globalAlpha = fade * 0.8;
    ctx.fillStyle = s.source === "echo" ? PAL.echo : s.source === "player" ? PAL.cyanDim : PAL.amber;
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Proximity vignette: MIMIC is close, even if you cannot see it.
  const near = game.mimicProximity();
  if (near > 0.35 && game.phase === "playing") {
    const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 6);
    ctx.save();
    ctx.globalAlpha = (near - 0.35) * 0.5 * (0.6 + 0.4 * pulse);
    const grad = ctx.createRadialGradient(
      DISPLAY_W / 2,
      DISPLAY_H / 2,
      Math.min(DISPLAY_W, DISPLAY_H) * 0.3,
      DISPLAY_W / 2,
      DISPLAY_H / 2,
      Math.max(DISPLAY_W, DISPLAY_H) * 0.6,
    );
    grad.addColorStop(0, alpha(PAL.red, 0));
    grad.addColorStop(1, alpha(PAL.red, 0.85));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    ctx.restore();
  }
}

/**
 * Centred one-line flash for link state changes. Glitches in and fades out —
 * loud enough to notice mid-chase, gone before it becomes furniture.
 */
function drawNotice(ctx: Ctx, game: Game): void {
  const notice = game.notice;
  if (!notice) return;

  // Corrupt hard on arrival, settle as it fades.
  const age = clamp(1 - notice.t / 1.8, 0, 1);
  const corruption = Math.max(0, 0.45 - age * 0.5);
  const fade = clamp(notice.t / 0.5, 0, 1);
  const color = notice.tone === "good" ? PAL.green : PAL.red;
  const cx = DISPLAY_W / 2;
  const cy = DISPLAY_H / 2 - 96;

  const label = garble(notice.text, corruption, Math.floor(game.elapsed * 24));

  // Channel-split ghosts, echoing the capture glitch at a fraction of the size.
  if (corruption > 0.02) {
    const off = 1 + corruption * 6;
    text(ctx, label, cx - off, cy, { size: 16, color: PAL.red, a: fade * 0.4, align: "center" });
    text(ctx, label, cx + off, cy, { size: 16, color: PAL.cyan, a: fade * 0.4, align: "center" });
  }
  text(ctx, label, cx, cy, { size: 16, color, a: fade, align: "center", bold: true });
}

/* -------------------------------------------------------------------- log */

function drawLog(ctx: Ctx, game: Game): void {
  const x = DISPLAY_W - 22;
  let y = DISPLAY_H - 34;
  for (let i = game.log.length - 1; i >= 0; i--) {
    const line = game.log[i];
    const fade = clamp(1 - (line.age - 5) / 2, 0, 1);
    if (fade <= 0) continue;
    text(ctx, line.text, x, y, {
      size: 11,
      color: TONE_COLOR[line.tone],
      a: fade * 0.9,
      align: "right",
    });
    y -= 16;
  }
}

/**
 * Facility PA. Sits at the top of the screen, away from the RETRACE notices, so
 * "the building is talking" never reads as "your link changed state".
 */
function drawAnnouncement(ctx: Ctx, game: Game): void {
  const a = game.alert.current;
  if (!a) return;
  const fade = clamp(a.t / 0.6, 0, 1);
  const cx = DISPLAY_W / 2;
  const y = 150;

  ctx.save();
  ctx.globalAlpha = fade * (0.3 + game.alert.strobe * 0.5);
  ctx.fillStyle = PAL.redDeep;
  ctx.fillRect(cx - 210, y - 20, 420, 28);
  ctx.restore();

  text(ctx, a.text, cx, y, {
    size: 14,
    color: PAL.redBright,
    a: fade,
    align: "center",
    bold: true,
  });
}

/* ------------------------------------------------------------------ debug */

/**
 * Developer overlay, toggled with F1 and off by default. Shows everything the
 * adaptation system is thinking, which is otherwise deliberately invisible.
 */
function drawDebug(ctx: Ctx, game: Game): void {
  const x = 22;
  let y = 176;
  const row = (label: string, value: string, color: string = PAL.grey): void => {
    text(ctx, label, x, y, { size: 10, color: PAL.greyDark });
    text(ctx, value, x + 190, y, { size: 10, color, align: "right" });
    y += 13;
  };

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(x - 10, y - 26, 212, 300);
  ctx.globalAlpha = 1;
  ctx.restore();

  text(ctx, "// MIMIC DIAGNOSTICS", x, y - 12, { size: 10, color: PAL.amber });

  const a = game.abilities;
  row("SYSTEM POWER", `${Math.round(a.power)} / ${POWER.max}`, a.powerFraction < 0.3 ? PAL.red : PAL.green);
  row("STATE", game.mimic.state.toUpperCase(), PAL.white);
  row("DETECTION", `${game.mimic.detectionPhase} ${game.mimic.detection.toFixed(2)}`, PAL.white);
  row("RETRACE", game.retraceJammed ? "JAMMED" : "CLEAR", game.retraceJammed ? PAL.red : PAL.green);
  row("LAST ABILITY", a.lastUsed ?? "-", PAL.cyan);
  row("ACTIVE", a.active ? `${a.active.id} ${a.active.t.toFixed(1)}s` : "-", PAL.cyan);
  row("PATTERN WEAR", game.analysis.familiarity().toFixed(2), PAL.white);

  const pl = game.player;
  row(
    "STAMINA",
    `${pl.stamina.toFixed(0)}/${STAMINA.max}${pl.exhausted ? " WINDED" : ""}`,
    pl.stamina < STAMINA.lowAt ? PAL.red : PAL.cyan,
  );
  row(
    "REGEN",
    `${STAMINA.regenRate}/s after ${STAMINA.regenDelay}s`,
    pl.staminaFraction < 1 ? PAL.white : PAL.greyDark,
  );
  // Puzzle diagnostics: every live signal, then every component's own state.
  // Toggled with the rest of the overlay on F1.
  row("CHAPTER", game.story.chapter.toUpperCase(), PAL.amber);
  const flags = game.story.flags.all();
  row("STORY FLAGS", flags.length ? flags.slice(0, 3).join(" ") : "none", PAL.amber);
  if (flags.length > 3) row("", flags.slice(3, 6).join(" "), PAL.amberDim);

  const active = game.puzzles.bus.active();
  row("SIGNALS", active.length ? active.slice(0, 4).join(" ") : "none", PAL.green);
  if (active.length > 4) row("", active.slice(4, 8).join(" "), PAL.greenDim);
  for (const line of game.puzzleDebugLines().slice(0, 10)) {
    const [id, ...rest] = line.split(/\s+/);
    row(id, rest.join(" "), PAL.grey);
  }

  row(
    "DASH",
    pl.charging
      ? `CHARGE ${(pl.charge * 100).toFixed(0)}/${(pl.maxCharge * 100).toFixed(0)}% -> ${pl.chargeCost.toFixed(0)}`
      : pl.dashing
        ? "BURST"
        : `cost ${DASH.costMin}-${DASH.costMax} max ${(pl.maxCharge * 100).toFixed(0)}%`,
    pl.charging ? PAL.cyanBright : PAL.greyDark,
  );
  row(
    "HUNT",
    game.hunt.active ? `${game.hunt.remaining.toFixed(0)}s ${game.hunt.reason}` : `cd${game.hunt.cooldown.toFixed(0)}`,
    game.hunt.active ? PAL.red : PAL.greyDark,
  );
  row("MUSIC", `L${game.music.intensity.toFixed(2)}`, PAL.cyan);
  row("EMERGENCY", game.alert.emergency.toFixed(2), game.alert.emergency > 0 ? PAL.red : PAL.greyDark);

  y += 6;
  text(ctx, "ADAPTATION", x, y, { size: 10, color: PAL.amber });
  y += 13;
  for (const { key, value } of game.adaptation.ranked()) {
    row(ADAPTATION_LABEL[key], value.toFixed(0), value > 40 ? PAL.red : PAL.grey);
  }

  y += 6;
  text(ctx, "COUNTERMEASURES", x, y, { size: 10, color: PAL.amber });
  y += 13;
  for (const id of Object.keys(ABILITY_TUNING) as (keyof typeof ABILITY_TUNING)[]) {
    const s = a.state(id);
    const cd = s.cooldown > 0 ? ` cd${s.cooldown.toFixed(0)}` : "";
    row(
      ABILITY_TUNING[id].name,
      s.unlocked ? `READY${cd}` : `${Math.round(s.progress * 100)}%`,
      s.unlocked ? (s.cooldown > 0 ? PAL.amberDim : PAL.green) : PAL.greyDark,
    );
  }
}

/* -------------------------------------------------------------- end cards */

function drawEndCards(ctx: Ctx, game: Game): void {
  if (game.phase === "playing") return;

  const cx = DISPLAY_W / 2;
  const cy = DISPLAY_H / 2;

  if (game.phase === "caught") {
    text(ctx, garble("SUBJECT REACQUIRED", 0.25, Math.floor(game.elapsed * 12)), cx, cy, {
      size: 30,
      color: PAL.red,
      align: "center",
      bold: true,
    });
    return;
  }

  if (game.phase === "collapse") {
    const t = clamp(1 - game.freezeT / 3, 0, 1);
    text(ctx, garble("TIMELINE FAILURE", 0.4 * t, Math.floor(game.elapsed * 20)), cx, cy, {
      size: 34,
      color: PAL.red,
      align: "center",
      bold: true,
    });
    text(ctx, "RESTORING BASELINE...", cx, cy + 34, {
      size: 14,
      color: PAL.redBright,
      align: "center",
      a: 0.8,
    });
    return;
  }

  // The closing sequence owns the screen first; this is the epilogue, not the
  // ending. Drawing both at once buried the one line the whole game builds to.
  if (game.endingT < ENDING_SECONDS) return;

  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.restore();

  text(ctx, "SURFACE REACHED", cx, cy - 20, {
    size: 38,
    color: PAL.green,
    align: "center",
    bold: true,
  });
  text(ctx, `SUBJECT 047 // ${game.run} ATTEMPTS`, cx, cy + 14, {
    size: 14,
    color: PAL.white,
    align: "center",
  });
  text(
    ctx,
    `MIMIC RETAINED ${game.memory.knowledge()}% OF YOU`,
    cx,
    cy + 38,
    { size: 13, color: PAL.red, align: "center", a: 0.9 },
  );
  text(ctx, "[ PRESS ENTER TO RUN IT AGAIN ]", cx, cy + 76, {
    size: 12,
    color: PAL.cyanDim,
    align: "center",
  });
}
