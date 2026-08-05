/**
 * MIMIC's ability tells.
 *
 * The design goal from the brief: "players should eventually recognize abilities
 * WITHOUT reading text." That is only achievable if each counter-measure looks
 * different from every other one — and three pairs used to share a shape, which
 * made it impossible by construction rather than by oversight.
 *
 * These tests own that invariant. The first is the load-bearing one: if a new
 * ability is added that reuses an existing silhouette, it fails here rather than
 * quietly making the language ambiguous again.
 */
import { describe, expect, it, vi } from "vitest";
import { TICK_DT } from "../src/core/constants";
import { ABILITY_TUNING, type AbilityId, type MimicFx } from "../src/ai/abilities";
import { createAbilities } from "../src/ai/ability-defs";
import { Adaptation } from "../src/ai/adaptation";
import { AnalysisBook } from "../src/ai/analysis";
import { Game } from "../src/game/game";
import { Rng } from "../src/core/rng";
import { MimicMemory } from "../src/systems/memory";
import { localStrategy } from "../src/systems/strategist";
import { Level, tileCenter } from "../src/world/level";
import { WING01 } from "../src/world/wing01";
import { FakeInput } from "./helpers";

vi.stubGlobal("fetch", undefined);

const CTX = {
  zones: ["top_hall"],
  hideSpots: [],
  objectivesComplete: [] as string[],
  nextObjective: "power",
  objectiveZone: "top_hall",
  lockdown: false,
};

/** Runs one ability's activation and collects the visuals it emits. */
function tellFor(id: AbilityId): MimicFx[] {
  const analysis = new AnalysisBook();
  const ability = createAbilities(analysis).get(id);
  if (!ability) throw new Error(`no ability ${id}`);

  const fx: MimicFx[] = [];
  const level = new Level(WING01);
  const memory = new MimicMemory();
  for (const z of ["top_hall", "west_hall", "maze"]) memory.data.routeCounts[z] = 12;
  const adaptation = new Adaptation(memory.data.adaptation);
  for (const k of Object.keys(adaptation.values)) {
    (adaptation.values as Record<string, number>)[k] = 90;
  }

  const here = tileCenter(30, 15);
  const there = tileCenter(21, 15);
  const ctx = {
    dt: TICK_DT,
    // Proxied rather than enumerated: an ability only needs MIMIC's data here,
    // and every command it issues is a no-op for the purposes of "what did it
    // draw". Listing methods by hand meant adding one broke this file.
    mimic: new Proxy(
      {
        x: here.x,
        y: here.y,
        state: "chase",
        lastKnown: { x: there.x, y: there.y },
        holdT: 0,
        distracted: 0,
      } as Record<string, unknown>,
      {
        get(target, prop) {
          if (prop in target) return target[prop as string];
          return () => {};
        },
      },
    ),
    adaptation,
    memory,
    strategy: localStrategy(memory, CTX),
    rng: new Rng(1),
    player: { x: there.x, y: there.y, hidden: false, zone: "top_hall" },
    playerConfirmed: true,
    echoes: [],
    world: {
      level,
      lockDoor: () => true,
      lockableDoors: () => ["hatch_maze_n"],
      surgeZone: () => {},
      cameraSightings: () => [
        { cameraId: "cam_spine", x: there.x, y: there.y, target: "player" as const, confidence: 0.9 },
      ],
      disturbancesNear: () => [
        { x: there.x, y: there.y, strength: 0.9, source: "player" as const },
      ],
      notice: () => {},
      log: () => {},
      play: () => {},
      emitFx: (f: Omit<MimicFx, "age">) => fx.push({ ...f, age: 0 }),
    },
  } as unknown as Parameters<typeof ability.activate>[0];

  // Abilities choose their target inside ready(); calling activate() alone
  // leaves them with nothing to point at, which is not how the manager runs them.
  ability.ready(ctx);
  ability.activate(ctx);
  return fx;
}

/** Abilities that actually activate. Passives never announce themselves. */
const ACTIVE = (Object.keys(ABILITY_TUNING) as AbilityId[]).filter(
  (id) => ABILITY_TUNING[id].cost > 0,
);

describe("every counter-measure looks like itself", () => {
  it("gives each active ability a visual, so nothing happens silently", () => {
    for (const id of ACTIVE) {
      const fx = tellFor(id);
      expect(fx.length, `${id} announced nothing`).toBeGreaterThan(0);
    }
  });

  it("never lets two abilities share a silhouette", () => {
    const byKind = new Map<string, AbilityId[]>();
    for (const id of ACTIVE) {
      for (const f of tellFor(id)) {
        const list = byKind.get(f.kind) ?? [];
        if (!list.includes(id)) list.push(id);
        byKind.set(f.kind, list);
      }
    }
    const shared = [...byKind.entries()].filter(([, ids]) => ids.length > 1);
    expect(
      shared.map(([k, ids]) => `${k}: ${ids.join(" + ")}`),
      "abilities sharing a tell are unreadable to the player",
    ).toEqual([]);
  });

  it("gives every directional tell somewhere to point", () => {
    // A line or wedge with no endpoint draws nothing at all.
    for (const id of ACTIVE) {
      for (const f of tellFor(id)) {
        if (["link", "predict", "lock", "intercept"].includes(f.kind)) {
          expect(f.toX, `${id} ${f.kind} has no target x`).toBeDefined();
          expect(f.toY, `${id} ${f.kind} has no target y`).toBeDefined();
        }
        expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
        expect(f.life).toBeGreaterThan(0);
      }
    }
  });
});

describe("the visual buffer stays bounded", () => {
  it("expires effects on their own, so nothing lingers", () => {
    // The buffer is bounded two ways: emitFx caps how many can be queued, and
    // every effect ages out. This covers the second — an effect that never
    // expired would sit on screen for the rest of the run.
    const game = new Game();
    const input = new FakeInput();
    game.mimicFx.push({ kind: "surge", x: 0, y: 0, radius: 10, age: 0, life: 0.5 });
    expect(game.mimicFx.length).toBe(1);

    for (let i = 0; i < 60; i++) game.tick(TICK_DT, input.asInput());
    expect(game.mimicFx.length).toBe(0);
  });
});
