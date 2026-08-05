/**
 * The narrative system.
 *
 * Everything the story does to the game goes through here, and everything it
 * needs from the game arrives as a `StoryContext`. That keeps the reveals out of
 * the simulation: `game.ts` does not know what the archives are, and this file
 * cannot accidentally move the player.
 *
 * The design rule from the brief, enforced structurally: show it with a
 * mechanic. This manager has no way to print "you have been here before" as a
 * conclusion. It can raise a flag, open a terminal, announce a facility line, or
 * put an ECHO in the room that the player knows they never recorded — and the
 * last one is the only one that ever says it.
 */
import { TILE } from "../core/constants";
import type { Rect } from "../world/level";
import { type ChapterId, type StoryFlag, StoryFlags } from "./flags";
import {
  ANNOUNCEMENTS,
  MIMIC_LINES,
  type MimicLineDef,
  TERMINALS,
  type TerminalDef,
} from "./content";
import { OLD_ECHO_LAB, type OldEchoDef } from "./old-echo";

export interface StoryContext {
  dt: number;
  elapsed: number;
  player: { x: number; y: number };
  /** How much MIMIC has learned, 0..100. Drives what it is allowed to say. */
  knowledge: number;
  mimicDetecting: boolean;
  echoCount: number;
  objectives: ReadonlySet<string>;
  /** Chapter-relevant facility state. */
  collapses: number;
  huntActive: boolean;
  /** Presentation hooks. Everything the story can do to the world. */
  announce(text: string, seconds: number, tone: string): void;
  log(text: string): void;
  mimicSays(text: string): void;
  spawnOldEcho(def: OldEchoDef): void;
  /** Nudges the camera toward a point for a moment. */
  focusCamera(x: number, y: number, seconds: number): void;
  glitch(strength: number): void;
  play(kind: string, volume: number): void;
}

/** An area that fires a story beat the first time the player walks into it. */
export interface StoryTrigger {
  id: string;
  flag: StoryFlag;
  area: Rect;
  /** Extra condition, so a beat cannot land before it makes sense. */
  when?: (ctx: StoryContext) => boolean;
  run: (ctx: StoryContext, story: StoryManager) => void;
}

const TRIGGERS: StoryTrigger[] = [
  {
    // The observation corridor. MIMIC is visible behind glass and cannot reach
    // you — the first sighting is deliberately safe, so the player learns the
    // shape before they learn the threat.
    id: "mimic_reveal",
    flag: "firstMimicSighting",
    area: { x: 43, y: 13, w: 10, h: 2 },
    run: (ctx, story) => {
      story.say(ANNOUNCEMENTS.observing.text, 3.5, "system");
      ctx.log("MONITORING CORE // OBSERVING");
      ctx.play("scan", 0.4);
    },
  },
  {
    // The abandoned end of the laboratory. Residue is heaviest here, and the
    // player has never RETRACEd in this room.
    id: "old_echo",
    flag: "oldEchoSeen",
    area: { x: 43, y: 6, w: 5, h: 6 },
    // Held back until the player has enough of their own ECHOs to know exactly
    // what one looks like. The moment only works if the grammar is fluent.
    when: (ctx) => ctx.echoCount >= 1,
    run: (ctx, story) => {
      story.say(ANNOUNCEMENTS.anomaly.text, 3.5, "warn");
      ctx.spawnOldEcho(OLD_ECHO_LAB);
      ctx.focusCamera((45 + 0.5) * TILE, (7 + 0.5) * TILE, 1.6);
      ctx.glitch(0.5);
    },
  },
  {
    id: "archives",
    flag: "archivesFound",
    area: { x: 43, y: 3, w: 5, h: 4 },
    run: (ctx) => {
      ctx.log("AXIOM ARCHIVES // PARTIAL POWER");
      ctx.play("link", 0.4);
    },
  },
];

export interface OpenTerminal {
  def: TerminalDef;
  /** Seconds the overlay has been open — drives the trial glitch. */
  t: number;
  /** Rendered body, resolved once on open. */
  title: string;
  lines: string[];
}

export class StoryManager {
  readonly flags = new StoryFlags();
  chapter: ChapterId = "test";

  /** Live announcement, if any. */
  announcement: { text: string; t: number; tone: string } | null = null;
  /** Terminal overlay the player is reading. */
  terminal: OpenTerminal | null = null;
  /** MIMIC's last line, shown separately from facility announcements. */
  mimicLine: { text: string; t: number } | null = null;

  /** Camera nudge request, consumed by the renderer. */
  focus: { x: number; y: number; t: number; total: number } | null = null;

  private firedTriggers = new Set<string>();
  private spokenLines = new Set<string>();
  private mimicCooldown = 0;

  /* ------------------------------------------------------------- lifecycle */

  tick(ctx: StoryContext): void {
    this.mimicCooldown = Math.max(0, this.mimicCooldown - ctx.dt);

    if (this.announcement) {
      this.announcement.t -= ctx.dt;
      if (this.announcement.t <= 0) this.announcement = null;
    }
    if (this.mimicLine) {
      this.mimicLine.t -= ctx.dt;
      if (this.mimicLine.t <= 0) this.mimicLine = null;
    }
    if (this.focus) {
      this.focus.t -= ctx.dt;
      if (this.focus.t <= 0) this.focus = null;
    }
    if (this.terminal) this.terminal.t += ctx.dt;

    this.updateChapter(ctx);
    this.checkTriggers(ctx);
  }

  /**
   * Chapters follow discovery, never a timer. A player who finds the archives
   * early gets the archives chapter early; the pacing is theirs.
   */
  private updateChapter(ctx: StoryContext): void {
    const f = this.flags;
    if (f.has("containmentTruthRevealed")) this.chapter = "containment";
    else if (f.has("archivesFound") || f.has("restorationCountRead")) this.chapter = "archives";
    else if (f.has("oldEchoSeen") || ctx.collapses > 0) this.chapter = "wrong";
    else if (f.has("firstMimicSighting") || f.has("firstDetection")) this.chapter = "observation";
    else this.chapter = "test";
  }

  private checkTriggers(ctx: StoryContext): void {
    const tx = Math.floor(ctx.player.x / TILE);
    const ty = Math.floor(ctx.player.y / TILE);
    for (const t of TRIGGERS) {
      if (this.firedTriggers.has(t.id)) continue;
      const a = t.area;
      if (tx < a.x || ty < a.y || tx >= a.x + a.w || ty >= a.y + a.h) continue;
      if (t.when && !t.when(ctx)) continue;
      this.firedTriggers.add(t.id);
      this.flags.raise(t.flag);
      t.run(ctx, this);
    }
  }

  /* ---------------------------------------------------------- announcements */

  /**
   * Puts a line on the facility announcement band.
   *
   * Sets the banner and nothing else. It used to also call `ctx.announce`, which
   * routes to the centre-screen notice — so every facility line appeared twice,
   * in two places, in two styles. One event, one place on screen.
   */
  say(text: string, seconds = 3.5, tone = "system"): void {
    this.announcement = { text, t: seconds, tone };
  }

  announce(_ctx: StoryContext, id: keyof typeof ANNOUNCEMENTS): void {
    const def = ANNOUNCEMENTS[id];
    if (!def) return;
    this.say(def.text, def.seconds ?? 3.5, def.tone ?? "system");
  }

  /* ------------------------------------------------------------ MIMIC lines */

  /**
   * Lets MIMIC speak, if it has earned the next thing it would say.
   *
   * Rarity is the whole effect. One line per detection at most, a long cooldown
   * between them, and each tier locked behind real learned knowledge — so "I
   * REMEMBER YOU" can only ever arrive after it demonstrably does.
   */
  offerMimicLine(ctx: StoryContext): MimicLineDef | null {
    if (this.mimicCooldown > 0) return null;
    for (const line of MIMIC_LINES) {
      if (this.spokenLines.has(line.id)) continue;
      if (ctx.knowledge < line.minKnowledge) continue;
      this.spokenLines.add(line.id);
      if (line.flag) this.flags.raise(line.flag);
      this.mimicLine = { text: line.text, t: 3.2 };
      this.mimicCooldown = 45;
      ctx.mimicSays(line.text);
      return line;
    }
    return null;
  }

  /* -------------------------------------------------------------- terminals */

  terminalFor(propId: string): TerminalDef | null {
    return TERMINALS.find((t) => t.propId === propId) ?? null;
  }

  openTerminal(def: TerminalDef, title: string, lines: string[]): void {
    this.terminal = { def, t: 0, title, lines };
    if (def.flag) this.flags.raise(def.flag);
  }

  closeTerminal(): void {
    this.terminal = null;
  }

  /**
   * True while the trial list should be showing impossible numbers.
   *
   * A third of a second, two seconds in, once. Long enough to register, short
   * enough that a player who blinks genuinely misses it — which is why the
   * archives repeat the information later in a form nobody can miss.
   */
  get trialGlitchActive(): boolean {
    const t = this.terminal;
    if (!t?.def.trialGlitch) return false;
    return t.t >= 2.0 && t.t <= 2.34;
  }

  requestFocus(x: number, y: number, seconds: number): void {
    this.focus = { x, y, t: seconds, total: seconds };
  }

  /* ------------------------------------------------------------------ debug */

  /** Developer panel: force a beat without playing to it. */
  debugFire(triggerId: string, ctx: StoryContext): boolean {
    const t = TRIGGERS.find((x) => x.id === triggerId);
    if (!t) return false;
    this.firedTriggers.add(t.id);
    this.flags.raise(t.flag);
    t.run(ctx, this);
    return true;
  }

  debugTriggerIds(): string[] {
    return TRIGGERS.map((t) => t.id);
  }

  debugReset(): void {
    this.flags.resetAll();
    this.firedTriggers.clear();
    this.spokenLines.clear();
    this.mimicCooldown = 0;
    this.announcement = null;
    this.terminal = null;
    this.mimicLine = null;
    this.chapter = "test";
  }
}
