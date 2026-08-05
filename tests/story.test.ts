/**
 * The narrative layer.
 *
 * Two properties matter more than any individual beat:
 *
 *  - A reveal fires once. A story moment that replays every RETRACE stops being
 *    a moment and becomes wallpaper.
 *  - A reveal never costs the player anything. Discovery survives resets, and an
 *    apparition must not consume an ECHO slot the player spent a run filling.
 *
 * The dossier tests exist because the terminals read real save data. If they
 * ever drift into inventing plausible numbers, the one moment the whole story
 * rests on — the player recognising their own corridor in MIMIC's file — is
 * quietly gone.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_DT, REQUIRED_OBJECTIVES } from "../src/core/constants";
import { ENDING, ENDING_SECONDS } from "../src/story/content";
import { Game } from "../src/game/game";
import { Adaptation } from "../src/ai/adaptation";
import { MimicMemory } from "../src/systems/memory";
import { Level, tileCenter } from "../src/world/level";
import { WING01 } from "../src/world/wing01";
import { PRIOR_RESTORATIONS, behaviourLines, restorationLines, trialLines } from "../src/story/dossier";
import { buildOldEcho, OLD_ECHO_LAB, isOldEcho } from "../src/story/old-echo";
import { StoryFlags } from "../src/story/flags";
import { FakeInput } from "./helpers";

const PARK = tileCenter(63, 43);

beforeAll(() => {
  vi.stubGlobal("fetch", undefined);
});

beforeEach(() => {
  MimicMemory.wipe();
});

function run(game: Game, input: FakeInput, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    game.mimic.reset(PARK.x, PARK.y);
    game.tick(TICK_DT, input.asInput());
  }
}

function holdAt(game: Game, input: FakeInput, tx: number, ty: number, ticks: number): void {
  const c = tileCenter(tx, ty);
  for (let i = 0; i < ticks; i++) {
    game.player.x = c.x;
    game.player.y = c.y;
    game.mimic.reset(PARK.x, PARK.y);
    game.tick(TICK_DT, input.asInput());
  }
}

describe("story flags", () => {
  it("raises each flag exactly once", () => {
    const f = new StoryFlags();
    expect(f.raise("archivesFound")).toBe(true);
    expect(f.raise("archivesFound")).toBe(false);
    expect(f.has("archivesFound")).toBe(true);
  });
});

describe("the opening", () => {
  it("does not hold the simulation unless the presentation layer asks", () => {
    // A headless Game must simulate immediately; only the boot gate plays the
    // title card. Getting this backwards froze every test for eleven seconds.
    const game = new Game();
    const input = new FakeInput();
    const before = game.elapsed;
    run(game, input, 10);
    expect(game.elapsed).toBeGreaterThan(before);
    expect(game.runTime).toBeGreaterThan(0);
  });

  it("freezes the run while it plays, and is not skippable the first time", () => {
    const game = new Game();
    const input = new FakeInput();
    game.beginOpening(false);
    expect(game.openingSkippable).toBe(false);

    const runTime = game.runTime;
    run(game, input, 60);
    expect(game.runTime).toBe(runTime);
  });
});

describe("story triggers", () => {
  it("fires the MIMIC reveal once and never again", () => {
    const game = new Game();
    const input = new FakeInput();

    // The observation corridor at the mouth of the laboratory.
    holdAt(game, input, 47, 14, 6);
    expect(game.story.flags.has("firstMimicSighting")).toBe(true);

    // Facility lines land on the announcement banner, and only there. They used
    // to also fire the centre-screen notice, so every one appeared twice.
    expect(game.story.announcement?.text).toBeTruthy();
    expect(game.notice).toBeNull();
    game.story.announcement = null;

    // Walking back through does nothing. A reveal is not wallpaper.
    holdAt(game, input, 30, 15, 4);
    holdAt(game, input, 47, 14, 6);
    expect(game.story.announcement).toBeNull();
  });

  it("holds the old-ECHO sighting back until the player owns an ECHO", () => {
    const game = new Game();
    const input = new FakeInput();

    // With nothing recorded, the beat has no grammar to subvert — so it waits.
    holdAt(game, input, 45, 8, 8);
    expect(game.story.flags.has("oldEchoSeen")).toBe(false);
  });
});

describe("the old ECHO", () => {
  it("is a real recording the replay system can drive", () => {
    const rec = buildOldEcho(OLD_ECHO_LAB, 1);
    expect(rec.length).toBeGreaterThan(60);
    expect(rec.xs.length).toBe(rec.length);
    expect(rec.flags.length).toBe(rec.length);
    expect(isOldEcho(rec.id)).toBe(true);
    // It actually goes somewhere.
    expect(Math.abs(rec.ys[0] - rec.ys[rec.length - 1])).toBeGreaterThan(16);
  });

  it("never costs the player an ECHO slot", () => {
    const game = new Game();
    const input = new FakeInput();

    // Fill the budget the hard way.
    for (let i = 0; i < 3; i++) {
      holdAt(game, input, 49, 3, 30);
      const before = game.run;
      input.hold("KeyR");
      for (let n = 0; n < 120 && game.run === before; n++) {
        game.mimic.reset(PARK.x, PARK.y);
        game.tick(TICK_DT, input.asInput());
      }
      input.release("KeyR");
    }
    expect(game.echoes.count).toBe(3);
    const ids = game.echoes.echoes.map((e) => e.rec.id);

    // Now walk into the apparition's room. Every recording must survive it.
    holdAt(game, input, 45, 8, 10);
    expect(game.story.flags.has("oldEchoSeen")).toBe(true);
    expect(game.echoes.count).toBe(3);
    for (const id of ids) {
      expect(game.echoes.echoes.some((e) => e.rec.id === id)).toBe(true);
    }
  });

  it("cleans itself up once it has finished", () => {
    const game = new Game();
    const input = new FakeInput();
    holdAt(game, input, 49, 3, 20);
    const before = game.run;
    input.hold("KeyR");
    for (let n = 0; n < 120 && game.run === before; n++) {
      game.mimic.reset(PARK.x, PARK.y);
      game.tick(TICK_DT, input.asInput());
    }
    input.release("KeyR");

    holdAt(game, input, 45, 8, 10);
    expect(game.echoes.echoes.some((e) => isOldEcho(e.rec.id))).toBe(true);

    // Its recording is a few seconds long; it should not linger past that.
    holdAt(game, input, 45, 8, 60 * 14);
    expect(game.echoes.echoes.some((e) => isOldEcho(e.rec.id))).toBe(false);
  });
});

describe("the dossier reads the real save", () => {
  const source = (memory: MimicMemory) => ({
    memory,
    adaptation: new Adaptation(memory.data.adaptation),
    level: new Level(WING01),
    run: 1,
    collapses: memory.data.collapses,
  });

  it("admits it has nothing rather than inventing a profile", () => {
    const lines = behaviourLines(source(new MimicMemory()));
    expect(lines.join(" ")).toContain("INSUFFICIENT DATA");
  });

  it("names the corridor the player actually favours", () => {
    const memory = new MimicMemory();
    for (let i = 0; i < 5; i++) {
      memory.noteZone("west_hall");
      memory.endRun("retrace", [], 20, "west_hall");
    }
    const lines = behaviourLines(source(memory)).join(" ");
    // The label, not the raw id — this is a facility document.
    expect(lines).toContain("WEST CORRIDOR");
    expect(lines).toContain("PREDICTION CONFIDENCE");
  });

  it("counts the player's own lost timelines into the restoration total", () => {
    const memory = new MimicMemory();
    const clean = restorationLines(source(memory)).join(" ");
    expect(clean).toContain(String(PRIOR_RESTORATIONS));

    memory.data.collapses = 3;
    const after = restorationLines(source(memory)).join(" ");
    expect(after).toContain(String(PRIOR_RESTORATIONS + 3));
  });

  it("shows an unremarkable trial list, and an impossible one when it corrupts", () => {
    const memory = new MimicMemory();
    const normal = trialLines(source(memory), false).join(" ");
    expect(normal).toContain("047 — ACTIVE");
    expect(normal).not.toContain("051");

    const glitched = trialLines(source(memory), true).join(" ");
    // Trials that have not happened yet, filed as already complete.
    expect(glitched).toContain("051 — COMPLETE");
  });
});

describe("MIMIC only says what it has earned", () => {
  it("stays silent until it has learned something", () => {
    const game = new Game();
    const ctx = {
      dt: TICK_DT,
      elapsed: 0,
      player: { x: 0, y: 0 },
      knowledge: 0,
      mimicDetecting: true,
      echoCount: 0,
      objectives: new Set<string>(),
      collapses: 0,
      huntActive: false,
      announce: () => {},
      log: () => {},
      mimicSays: () => {},
      spawnOldEcho: () => {},
      focusCamera: () => {},
      glitch: () => {},
      play: () => {},
    };

    // The first line is free; the rest are not.
    expect(game.story.offerMimicLine(ctx)?.id).toBe("detected");
    // Cooldown holds it back even when knowledge is high.
    expect(game.story.offerMimicLine({ ...ctx, knowledge: 100 })).toBeNull();
  });

  it("cannot reach its last line without genuinely knowing the player", () => {
    const game = new Game();
    const base = {
      dt: TICK_DT,
      elapsed: 0,
      player: { x: 0, y: 0 },
      mimicDetecting: true,
      echoCount: 0,
      objectives: new Set<string>(),
      collapses: 0,
      huntActive: false,
      announce: () => {},
      log: () => {},
      mimicSays: () => {},
      spawnOldEcho: () => {},
      focusCamera: () => {},
      glitch: () => {},
      play: () => {},
    };

    const spoken: string[] = [];
    for (let i = 0; i < 12; i++) {
      // Low knowledge forever: it can never say it remembers you.
      const line = game.story.offerMimicLine({ ...base, knowledge: 10 });
      if (line) spoken.push(line.id);
      // Skip past the cooldown.
      game.story.tick({ ...base, dt: 50, knowledge: 10 });
    }
    expect(spoken).not.toContain("remember");
    expect(game.story.flags.has("mimicPurposeRevealed")).toBe(false);
  });
});

describe("the ending", () => {
  /**
   * The closing sequence sat written but unwired for most of development — the
   * data existed in content.ts and nothing ever rendered or advanced it, so the
   * game had no conclusion at all. These pin that it runs, finishes, and is
   * skippable, because an ending that only exists in a data file is not one.
   */
  it("starts counting the moment Subject 047 reaches the surface", () => {
    const game = new Game();
    const input = new FakeInput();
    for (const id of REQUIRED_OBJECTIVES) game.objectives.add(id);

    const lift = game.level.props.find((p) => p.kind === "exit")!;
    const c = tileCenter(lift.tx, lift.ty);
    game.player.reset(c.x, c.y);
    input.press("KeyE");
    run(game, input, 3);

    expect(game.phase).toBe("escaped");
    expect(game.endingT).toBeGreaterThan(0);
  });

  it("plays to the end rather than stalling part-way", () => {
    const game = new Game();
    const input = new FakeInput();
    game.phase = "escaped";

    // The simulation is frozen once escaped; the closing clock must still run,
    // or the sequence never reaches its last line.
    for (let i = 0; i < Math.ceil(ENDING_SECONDS / TICK_DT) + 60; i++) {
      game.tick(TICK_DT, input.asInput());
    }
    expect(game.endingT).toBeGreaterThanOrEqual(ENDING_SECONDS);
  });

  it("reaches its final line, which is the one the game is built around", () => {
    // Every line must land inside the sequence's own runtime — a beat scheduled
    // past the end is a beat nobody ever sees.
    const last = ENDING[ENDING.length - 1];
    expect(last.at).toBeLessThan(ENDING_SECONDS);
    expect(ENDING.some((l) => l.text.includes("100%"))).toBe(true);
    expect(ENDING.some((l) => l.text.includes("THE FUTURE CAN'T"))).toBe(true);
  });
});
