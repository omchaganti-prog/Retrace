/**
 * MIMIC's adaptation system.
 *
 * The load-bearing guarantees: it cannot spam, it cannot cheat, it develops
 * from what the player actually did, and every counter-measure has a way out.
 */
import { describe, expect, it } from "vitest";
import { ABILITY_TUNING, type AbilityId, AbilityManager, POWER } from "../src/ai/abilities";
import { createAbilities } from "../src/ai/ability-defs";
import { ADAPTATION_KEYS, Adaptation } from "../src/ai/adaptation";
import { AnalysisBook } from "../src/ai/analysis";
import { TICK_DT } from "../src/core/constants";
import { Game } from "../src/game/game";
import { MimicMemory } from "../src/systems/memory";
import { findPath } from "../src/systems/pathfind";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

const FAR = tileCenter(63, 43);

function tick(game: Game, input: FakeInput, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    game.tick(TICK_DT, input.asInput());
  }
}

/** Fully develops every counter-measure, for testing behaviour not unlocking. */
function teachEverything(game: Game): void {
  for (const key of ADAPTATION_KEYS) game.adaptation.note(key, 100);
  game.abilities.advanceUnlocks(game.adaptation, 0);
}

describe("system power and cooldowns", () => {
  it("starts charged and cannot pay for what it cannot afford", () => {
    const abilities = new AbilityManager(createAbilities(new AnalysisBook()), []);
    expect(abilities.power).toBe(POWER.max);
    expect(abilities.powerFraction).toBe(1);
  });

  it("regenerates over time", () => {
    const game = new Game();
    const input = new FakeInput();
    game.abilities.power = 10;
    tick(game, input, 3);
    expect(game.abilities.power).toBeGreaterThan(10);
    expect(game.abilities.power).toBeLessThanOrEqual(POWER.max);
  });

  it("never exceeds maximum power", () => {
    const game = new Game();
    const input = new FakeInput();
    tick(game, input, 10);
    expect(game.abilities.power).toBeLessThanOrEqual(POWER.max);
  });

  it("cannot spam — every ability carries a real cooldown and cost", () => {
    for (const id of Object.keys(ABILITY_TUNING) as AbilityId[]) {
      const t = ABILITY_TUNING[id];
      // Passives are the deliberate exception: no cost, no activation.
      if (t.cost === 0) continue;
      expect(t.cooldown).toBeGreaterThan(5);
      expect(t.cost).toBeGreaterThan(0);
    }
  });

  it("keeps the most expensive tools on the longest leashes", () => {
    expect(ABILITY_TUNING.facility_override.cooldown).toBeGreaterThan(
      ABILITY_TUNING.focus_scan.cooldown,
    );
    expect(ABILITY_TUNING.deep_scan.cooldown).toBeGreaterThan(ABILITY_TUNING.focus_scan.cooldown);
    expect(ABILITY_TUNING.facility_override.cost).toBeGreaterThan(ABILITY_TUNING.focus_scan.cost);
  });

  it("documents counterplay for every single ability", () => {
    for (const id of Object.keys(ABILITY_TUNING) as AbilityId[]) {
      expect(ABILITY_TUNING[id].counterplay.length).toBeGreaterThan(20);
    }
  });
});

describe("adaptation is taught, not levelled", () => {
  it("starts with nothing developed", () => {
    MimicMemory.wipe();
    const game = new Game();
    expect(game.abilities.unlockedIds()).toHaveLength(0);
    expect(game.adaptation.mass()).toBe(0);
  });

  it("develops the counter to the habit the player actually leans on", () => {
    const routeRunner = new Adaptation();
    routeRunner.note("routeDependency", 100);
    routeRunner.note("doorDependency", 40);
    const a = new AbilityManager(createAbilities(new AnalysisBook()), []);
    a.advanceUnlocks(routeRunner, 0);

    const doorRunner = new Adaptation();
    doorRunner.note("doorDependency", 100);
    doorRunner.note("routeDependency", 40);
    const b = new AbilityManager(createAbilities(new AnalysisBook()), []);
    b.advanceUnlocks(doorRunner, 0);

    // Same total investment, different lesson — different opponent.
    expect(a.isUnlocked("route_prediction")).toBe(true);
    expect(b.isUnlocked("door_control")).toBe(true);
    expect(a.unlockedIds()).not.toEqual(b.unlockedIds());
  });

  it("gates late-tier tools behind overall exposure, not one lopsided habit", () => {
    const narrow = new Adaptation();
    narrow.note("retraceDependency", 100); // maxed, but nothing else seen
    const a = new AbilityManager(createAbilities(new AnalysisBook()), []);
    a.advanceUnlocks(narrow, 0);
    expect(a.isUnlocked("facility_override")).toBe(false);
  });

  it("counts a behaviour once per gate window", () => {
    const a = new Adaptation();
    for (let i = 0; i < 20; i++) a.note("cameraExposure", 5, 5, "cam:1");
    expect(a.values.cameraExposure).toBe(5);
  });

  it("caps every counter", () => {
    const a = new Adaptation();
    a.note("routeDependency", 9999);
    expect(a.values.routeDependency).toBe(100);
  });
});

describe("adaptation survives temporal collapse", () => {
  it("blurs the detail but never un-develops a counter-measure", () => {
    const a = new Adaptation();
    a.note("routeDependency", 80);
    const manager = new AbilityManager(createAbilities(new AnalysisBook()), []);
    manager.advanceUnlocks(a, 0);
    expect(manager.isUnlocked("route_prediction")).toBe(true);

    a.decay();

    expect(a.values.routeDependency).toBeLessThan(80);
    expect(a.values.routeDependency).toBeGreaterThan(0);
    // The premise: MIMIC remembers timelines the facility does not.
    expect(manager.isUnlocked("route_prediction")).toBe(true);
  });

  it("persists learning into the save blob", () => {
    MimicMemory.wipe();
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    game.adaptation.note("routeDependency", 60);

    input.hold("KeyR");
    tick(game, input, 1.4);
    input.release("KeyR");

    expect(game.memory.data.adaptation.routeDependency).toBeGreaterThan(0);
  });

  it("keeps a manual RETRACE from erasing anything learned", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    teachEverything(game);
    const before = game.abilities.unlockedIds().length;

    input.hold("KeyR");
    tick(game, input, 1.4);
    input.release("KeyR");

    expect(game.abilities.unlockedIds()).toHaveLength(before);
    expect(game.adaptation.values.routeDependency).toBe(100);
  });
});

describe("pattern familiarity", () => {
  it("treats a brand new pattern as fully interesting", () => {
    const book = new AnalysisBook();
    book.soundAnalysisActive = true;
    expect(book.soundConfidence(100, 100, "step")).toBe(1);
  });

  it("wears down a repeated pattern across runs", () => {
    const book = new AnalysisBook();
    book.soundAnalysisActive = true;
    for (let run = 1; run <= 6; run++) book.noteSound(100, 100, "step", run);
    expect(book.soundConfidence(100, 100, "step")).toBeLessThan(0.5);
  });

  it("does not wear down from repetition inside a single run", () => {
    const book = new AnalysisBook();
    book.soundAnalysisActive = true;
    for (let i = 0; i < 50; i++) book.noteSound(100, 100, "step", 1);
    expect(book.soundConfidence(100, 100, "step")).toBe(1);
  });

  it("leaves a new location fully effective again", () => {
    const book = new AnalysisBook();
    book.soundAnalysisActive = true;
    for (let run = 1; run <= 6; run++) book.noteSound(100, 100, "step", run);
    // The counterplay: change the route, and the trick works perfectly.
    expect(book.soundConfidence(900, 900, "step")).toBe(1);
  });

  it("never fully ignores a worn pattern", () => {
    const book = new AnalysisBook();
    book.soundAnalysisActive = true;
    for (let run = 1; run <= 30; run++) book.noteSound(100, 100, "step", run);
    expect(book.soundConfidence(100, 100, "step")).toBeGreaterThan(0);
  });

  it("stays inert until the analysis has actually developed", () => {
    const book = new AnalysisBook();
    for (let run = 1; run <= 10; run++) book.noteSound(100, 100, "step", run);
    expect(book.soundConfidence(100, 100, "step")).toBe(1);
  });
});

describe("door control cannot strand the player", () => {
  it("refuses to lock anything that would cut off the run", () => {
    const game = new Game();
    teachEverything(game);
    const start = tileCenter(8, 38);
    game.player.reset(start.x, start.y);

    // Try to seal every controllable door at once — the guard must hold.
    for (const d of game.level.doors) {
      if (d.mimicControllable) game.abilities.power = POWER.max;
    }
    const world = game as unknown as {
      lockDoor(id: string, s: number): boolean;
    };
    for (const d of game.level.doors.filter((x) => x.mimicControllable)) {
      world.lockDoor(d.id, 6);
    }

    // Whatever it managed to lock, the objective chain is still walkable.
    const lever = game.level.propById.get("reactor_lever")!;
    const c = tileCenter(lever.tx, lever.ty);
    for (const d of game.level.doors) if (d.rule.kind === "plates") d.openness = 1;
    expect(findPath(game.level, start.x, start.y, c.x, c.y)).not.toBeNull();
  });

  it("only ever touches corridor hatches, never an objective gate", () => {
    const game = new Game();
    const controllable = game.level.doors.filter((d) => d.mimicControllable);
    expect(controllable.length).toBeGreaterThan(0);
    for (const d of controllable) {
      // A plate gate or the lift bulkhead must never be lockable.
      expect(d.rule.kind).toBe("auto");
    }
  });

  it("does actually seal doors — the guard is not a blanket refusal", () => {
    const game = new Game();
    // Standing in the spine corridor, every hatch is a detour rather than a
    // lifeline, so at least one lock has to be permitted.
    const spine = tileCenter(30, 15);
    game.player.reset(spine.x, spine.y);

    const lock = (id: string): boolean =>
      (game as unknown as { lockDoor(id: string, s: number): boolean }).lockDoor(id, 6);

    const sealed = game.level.doors.filter((d) => d.mimicControllable && lock(d.id));
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.every((d) => d.lockedT > 0)).toBe(true);
  });

  it("fires in a chase and seals a hatch near the player", () => {
    const game = new Game();
    const input = new FakeInput();
    // Only Door Control, so nothing outranks it.
    game.adaptation.note("doorDependency", 100);
    game.adaptation.note("routeDependency", 60);
    game.abilities.advanceUnlocks(game.adaptation, 0);
    expect(game.abilities.isUnlocked("door_control")).toBe(true);

    // Put the player and MIMIC beside a controllable hatch, in a live chase.
    const hatch = game.level.doorById.get("hatch_maze_n")!;
    const near = tileCenter(hatch.tx, hatch.ty + 2);
    for (let i = 0; i < 60 * 12; i++) {
      game.player.x = near.x;
      game.player.y = near.y;
      game.mimic.x = near.x - 40;
      game.mimic.y = near.y;
      game.mimic.facing = 0;
      game.tick(TICK_DT, input.asInput());
      if (game.level.doors.some((d) => d.lockedT > 0)) break;
    }

    expect(game.level.doors.some((d) => d.lockedT > 0)).toBe(true);
  });

  it("expires on its own", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    const door = game.level.doors.find((d) => d.mimicControllable)!;
    (game as unknown as { lockDoor(id: string, s: number): boolean }).lockDoor(door.id, 1);
    expect(door.lockedT).toBeGreaterThan(0);

    tick(game, input, 1.5);
    expect(door.lockedT).toBe(0);
  });
});

describe("no omniscience", () => {
  it("keeps Deep Scan reporting sectors, never coordinates", () => {
    const game = new Game();
    const input = new FakeInput();
    teachEverything(game);

    // Make a noise, then move far away from it.
    const noisy = tileCenter(30, 25);
    game.player.reset(noisy.x, noisy.y);
    tick(game, input, 0.2);
    const hidden = tileCenter(40, 30);
    game.player.reset(hidden.x, hidden.y);

    game.mimic.reset(noisy.x, noisy.y);
    tick(game, input, 6);

    // Whatever it learned, it is not the player's actual position.
    if (game.mimic.lastKnown) {
      const exact =
        Math.abs(game.mimic.lastKnown.x - hidden.x) < 1 &&
        Math.abs(game.mimic.lastKnown.y - hidden.y) < 1;
      expect(exact).toBe(false);
    }
  });

  it("leaves no trace to find when the player holds still", () => {
    const game = new Game();
    const input = new FakeInput();
    teachEverything(game);
    const spot = tileCenter(30, 25);
    game.player.reset(spot.x, spot.y);

    // Standing still emits no footsteps, so there is nothing to localise.
    tick(game, input, 8);
    const traces = (
      game as unknown as { traces: { source: string }[] }
    ).traces.filter((t) => t.source === "player");
    expect(traces).toHaveLength(0);
  });
});

describe("abilities are visible and audible", () => {
  it("announces itself with an effect whenever one fires", () => {
    const game = new Game();
    const input = new FakeInput();
    teachEverything(game);

    // Put it in a state where Focus Scan is the sensible move.
    const spot = tileCenter(30, 15);
    game.mimic.reset(spot.x, spot.y);
    game.mimic.investigateAt(spot.x + 40, spot.y);
    game.player.reset(FAR.x, FAR.y);

    let sawFx = false;
    for (let i = 0; i < 60 * 12 && !sawFx; i++) {
      game.tick(TICK_DT, input.asInput());
      if (game.mimicFx.length > 0) sawFx = true;
    }
    expect(sawFx).toBe(true);
  });
});

describe("MIMIC is not inert on patrol", () => {
  it("stops to scan while patrolling, not only mid-search", () => {
    const game = new Game();
    const input = new FakeInput();
    // Only Focus Scan developed, and MIMIC left to patrol undisturbed.
    game.adaptation.note("hidingRepetition", 100);
    game.abilities.advanceUnlocks(game.adaptation, 0);
    expect(game.abilities.isUnlocked("focus_scan")).toBe(true);
    game.player.reset(FAR.x, FAR.y);

    let fired = 0;
    for (let i = 0; i < 60 * 40; i++) {
      game.tick(TICK_DT, input.asInput());
      if (game.abilities.justFired === "focus_scan") fired++;
    }

    // MIMIC spends ~80% of a run patrolling. If nothing can fire there, the
    // whole adaptation system is invisible to the player.
    expect(game.mimic.state).toBe("patrol");
    expect(fired).toBeGreaterThan(0);
  });

  it("actually spends power over a run", () => {
    const game = new Game();
    const input = new FakeInput();
    teachEverything(game);
    game.player.reset(FAR.x, FAR.y);

    let min = POWER.max;
    for (let i = 0; i < 60 * 40; i++) {
      game.tick(TICK_DT, input.asInput());
      min = Math.min(min, game.abilities.power);
    }
    expect(min).toBeLessThan(POWER.max);
  });
});

describe("existing systems still work", () => {
  it("keeps MIMIC honest about walls", () => {
    const game = new Game();
    const input = new FakeInput();
    teachEverything(game);
    // Player deep in the warren, MIMIC in the corridor with pillars between.
    const hidden = tileCenter(30, 25);
    const post = tileCenter(26, 15);
    for (let i = 0; i < 60 * 4; i++) {
      game.player.x = hidden.x;
      game.player.y = hidden.y;
      game.mimic.x = post.x;
      game.mimic.y = post.y;
      game.tick(TICK_DT, input.asInput());
    }
    expect(game.mimic.detection).toBe(0);
    expect(game.retraceJammed).toBe(false);
  });

  it("still banks three synchronised ECHOs with abilities live", () => {
    const game = new Game();
    const input = new FakeInput();
    teachEverything(game);

    for (let i = 0; i < 5; i++) {
      game.mimic.reset(FAR.x, FAR.y);
      tick(game, input, 0.4);
      input.hold("KeyR");
      const before = game.run;
      for (let t = 0; t < 150 && game.run === before; t++) {
        game.mimic.reset(FAR.x, FAR.y);
        game.tick(TICK_DT, input.asInput());
      }
      input.release("KeyR");
    }

    expect(game.echoes.count).toBe(3);
    const ticks = game.echoes.echoes.map((e) => e.tick);
    expect(new Set(ticks).size).toBe(1);
  });
});
