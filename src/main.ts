/**
 * Entry point: canvas setup, the fixed-timestep loop, and the boot gate.
 *
 * The simulation only ever advances in whole TICK_DT steps. Rendering happens
 * once per animation frame regardless — decoupling the two is what lets ECHO
 * recordings stay frame-exact on a machine that cannot hold 60 FPS.
 */
import { MAX_TICKS_PER_FRAME, TICK_DT } from "./core/constants";
import { EYE_STATES } from "./render/mimic-eye";
import { ENDING_SECONDS } from "./story/content";
import { Input } from "./core/input";
import { Game } from "./game/game";
import { drawHud } from "./render/hud";
import {
  drawAnnouncement,
  drawEnding,
  drawOpening,
  drawTerminal,
} from "./render/story-overlay";
import { DISPLAY_H, DISPLAY_W, Renderer } from "./render/renderer";
import { findPath } from "./systems/pathfind";
import { tileCenter } from "./world/level";
import { PAL } from "./render/palette";
import { ctxOf } from "./render/pixels";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
const boot = document.getElementById("boot");
if (!canvas) throw new Error("#game canvas missing from index.html");

canvas.width = DISPLAY_W;
canvas.height = DISPLAY_H;
const ctx = ctxOf(canvas);

const input = new Input();
input.attach();
const renderer = new Renderer();
let game = new Game();

let started = false;
/** Once the boot sequence has been seen, it may be skipped. */
let openingSeen = false;
let paused = false;
let accumulator = 0;
let last = performance.now();

/** Letterbox the fixed-size canvas into whatever the window happens to be. */
function fit(): void {
  const scale = Math.min(window.innerWidth / DISPLAY_W, window.innerHeight / DISPLAY_H);
  canvas!.style.width = `${Math.floor(DISPLAY_W * scale)}px`;
  canvas!.style.height = `${Math.floor(DISPLAY_H * scale)}px`;
}
fit();
window.addEventListener("resize", fit);

function start(): void {
  if (started) return;
  started = true;
  boot?.classList.add("hidden");
  // Audio contexts only unlock inside a user gesture. The score shares that
  // context, so it can only be built here.
  game.sfx.resume();
  void game.music.attach(game.sfx.context, game.sfx.musicOut);
  // The facility introduces itself before Subject 047 can walk away from it.
  // Skippable only once it has been sat through in this session.
  game.beginOpening(openingSeen);
  openingSeen = true;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  game.alert.reducedFlashing = reduced;
  game.settings.applySystemPreferences(reduced);
  last = performance.now();
}

boot?.addEventListener("click", start);
window.addEventListener("keydown", start, { once: false });

window.addEventListener("blur", () => {
  paused = true;
});

function handleMetaKeys(): void {
  // Escape belongs to whatever is on top. With a terminal open it closes the
  // terminal; meta keys run before the tick, so consuming it here first meant
  // Escape paused the game *behind* the still-open terminal.
  if (!game.story.terminal && input.consumePress("Escape")) paused = !paused;
  if (input.consumePress("F1")) {
    game.debug = !game.debug;
    game.pushLog(game.debug ? "DIAGNOSTICS ON" : "DIAGNOSTICS OFF", "info");
  }
  // Accessibility dials, live and without leaving the game.
  if (paused) {
    if (input.consumePress("Digit1")) {
      game.pushLog(`SCREEN SHAKE // ${game.settings.cycle("screenShake").toUpperCase()}`, "info");
    }
    if (input.consumePress("Digit2")) {
      game.pushLog(`GLITCH // ${game.settings.cycle("glitch").toUpperCase()}`, "info");
    }
    if (input.consumePress("Digit4")) {
      game.settings.mimicFootsteps = !game.settings.mimicFootsteps;
      game.pushLog(
        `MIMIC FOOTSTEPS // ${game.settings.mimicFootsteps ? "ON" : "OFF"}`,
        "info",
      );
    }
    if (input.consumePress("Digit3")) {
      game.pushLog(`FLASHING // ${game.settings.cycle("flashing").toUpperCase()}`, "info");
    }
  }
  // Eye tuning. Only while diagnostics are up, so it can never fire in play.
  //
  // Cycling the eye through its states by hand is the only practical way to
  // tune them: several are moments rather than modes — the lock flash, the
  // prediction sweep, the failure flicker — and waiting for MIMIC to produce
  // one naturally can take an entire run.
  if (game.debug && input.consumePress("BracketRight")) {
    const list = EYE_STATES;
    const at = game.eye.forcedState ? list.indexOf(game.eye.forcedState) : -1;
    const next = at + 1 >= list.length ? null : list[at + 1];
    game.eye.force(next);
    game.pushLog(`EYE // ${next ? next.toUpperCase() : "LIVE"}`, "info");
  }
  if (game.debug && input.consumePress("BracketLeft")) {
    game.eye.force(null);
    game.pushLog("EYE // LIVE", "info");
  }
  if (input.consumePress("KeyM")) {
    game.sfx.muted = !game.sfx.muted;
    game.music.muted = game.sfx.muted;
    game.pushLog(game.sfx.muted ? "AUDIO MUTED" : "AUDIO ON", "info");
  }
  // Enter during the closing sequence skips it; Enter after starts a new run.
  // Gating restart behind the whole sequence would feel unresponsive, and
  // letting Enter restart *through* it means an impatient tap eats the ending.
  if (game.phase === "escaped" && game.endingT < ENDING_SECONDS) {
    if (input.consumePress("Enter")) game.endingT = ENDING_SECONDS;
  } else if (game.phase === "escaped" && input.consumePress("Enter")) {
    const wasMuted = game.sfx.muted;
    const reduced = game.alert.reducedFlashing;
    // Accessibility choices are the player's, not the run's. Carrying the whole
    // Settings object across means someone who turned flashing off does not have
    // to turn it off again every time they finish the game.
    const settings = game.settings;
    game = new Game();
    game.sfx.resume();
    game.sfx.muted = wasMuted;
    game.music.muted = wasMuted;
    game.alert.reducedFlashing = reduced;
    game.adoptSettings(settings);
    void game.music.attach(game.sfx.context, game.sfx.musicOut);
    game.beginOpening(true);
  }
}

function overlay(message: string, sub: string, rows: string[] = []): void {
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  ctx.fillStyle = PAL.cyan;
  ctx.font = '28px "Consolas", "DejaVu Sans Mono", monospace';
  ctx.fillText(message, DISPLAY_W / 2, DISPLAY_H / 2);
  ctx.fillStyle = PAL.grey;
  ctx.font = '13px "Consolas", "DejaVu Sans Mono", monospace';
  ctx.fillText(sub, DISPLAY_W / 2, DISPLAY_H / 2 + 30);
  // Settings sit under the controls line, adjustable without leaving the pause.
  ctx.font = '12px "Consolas", "DejaVu Sans Mono", monospace';
  ctx.fillStyle = PAL.cyanDim;
  rows.forEach((r, i) => ctx.fillText(r, DISPLAY_W / 2, DISPLAY_H / 2 + 68 + i * 20));
  ctx.restore();
}

function frame(now: number): void {
  requestAnimationFrame(frame);

  const rawDt = (now - last) / 1000;
  last = now;

  if (started) {
    handleMetaKeys();

    const active = !paused && input.focused && !document.hidden;
    if (active) {
      // Clamped so a backgrounded tab does not resume with a burst of ticks.
      accumulator += Math.min(rawDt, TICK_DT * MAX_TICKS_PER_FRAME);
      let steps = 0;
      while (accumulator >= TICK_DT && steps < MAX_TICKS_PER_FRAME) {
        input.advance(TICK_DT);
        game.tick(TICK_DT, input);
        accumulator -= TICK_DT;
        steps++;
      }
    } else {
      accumulator = 0;
    }
    input.endFrame();
  }

  renderer.draw(ctx, game);
  drawHud(ctx, game);
  drawAnnouncement(ctx, game);
  drawTerminal(ctx, game);
  drawEnding(ctx, game);
  drawOpening(ctx, game);

  if (started && (paused || !input.focused)) {
    overlay(
      "SIMULATION SUSPENDED",
      "[ESC] RESUME   WASD MOVE   [SPACE] DASH   [E] INTERACT   HOLD [R] RETRACE",
      game.settings.lines(),
    );
  }
}

// Dev-only handle for debugging and automated checks. `import.meta.env.DEV` is
// statically false in a production build, so this block is stripped entirely.
if (import.meta.env.DEV) {
  Object.defineProperty(window, "__retrace", {
    value: {
      get game() {
        return game;
      },
      renderer,
      input,
      // Enough for an automated walkthrough to steer the player the same way
      // MIMIC steers itself — real paths, real collision, real input.
      findPath,
      tileCenter,
    },
  });
}

requestAnimationFrame(frame);
