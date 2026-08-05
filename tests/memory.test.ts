/**
 * Acceptance criterion: "After multiple runs, verify MIMIC's memory counters
 * increment (e.g. using the same corridor increases its future visits)."
 */
import { describe, expect, it } from "vitest";
import { MimicMemory } from "../src/systems/memory";
import { localStrategy } from "../src/systems/strategist";

const CTX = {
  zones: ["start", "west_hall", "top_hall", "maze", "power", "vault"],
  hideSpots: ["hide_west_alcove", "hide_maze_nw"],
  objectivesComplete: [] as string[],
  nextObjective: "power",
  objectiveZone: "power",
  lockdown: false,
};

function runThrough(memory: MimicMemory, zones: string[]): void {
  for (const z of zones) memory.noteZone(z);
  memory.endRun("retrace", [], 30, zones[zones.length - 1] ?? null);
}

describe("mimic memory", () => {
  it("counts the routes you actually take", () => {
    const m = new MimicMemory();
    runThrough(m, ["start", "west_hall", "maze"]);
    runThrough(m, ["start", "west_hall", "top_hall"]);

    expect(m.data.routeCounts.west_hall).toBe(2);
    expect(m.data.routeCounts.maze).toBe(1);
    expect(m.rankedRoutes()[0].id).toBe("start");
    expect(m.data.runs).toBe(2);
  });

  it("ignores an immediate repeat of the same zone", () => {
    const m = new MimicMemory();
    m.noteZone("maze");
    m.noteZone("maze");
    m.noteZone("maze");
    expect(m.currentRoute).toEqual(["maze"]);
  });

  it("records catches against the zone you were caught in", () => {
    const m = new MimicMemory();
    m.noteZone("vault");
    m.endRun("caught", [], 12, "vault");
    expect(m.data.catches).toBe(1);
    expect(m.data.catchZones.vault).toBe(1);
  });

  it("decays but never forgets on collapse", () => {
    const m = new MimicMemory();
    for (let i = 0; i < 6; i++) runThrough(m, ["start", "west_hall"]);
    const before = m.data.routeCounts.west_hall;

    m.decayOnCollapse();

    expect(m.data.routeCounts.west_hall).toBeLessThan(before);
    expect(m.data.routeCounts.west_hall).toBeGreaterThan(0);
  });

  it("climbs its knowledge readout as it watches you", () => {
    const m = new MimicMemory();
    const start = m.knowledge();
    for (let i = 0; i < 5; i++) {
      m.noteStrategy("echo_bait");
      m.noteHide("hide_maze_nw");
      runThrough(m, ["start", "west_hall", "maze", "top_hall"]);
    }
    expect(m.knowledge()).toBeGreaterThan(start);
    expect(m.knowledge()).toBeLessThanOrEqual(100);
  });

  it("keeps only a bounded window of recent runs", () => {
    const m = new MimicMemory();
    for (let i = 0; i < 20; i++) runThrough(m, ["start"]);
    expect(m.data.recent.length).toBeLessThanOrEqual(8);
    expect(m.data.runs).toBe(20);
  });
});

describe("local strategist", () => {
  it("only ever names ids from the supplied vocabulary", () => {
    const m = new MimicMemory();
    runThrough(m, ["start", "west_hall", "maze"]);
    m.noteHide("hide_west_alcove");
    m.endRun("retrace", [], 10, "maze");

    const s = localStrategy(m, CTX);
    for (const z of s.patrolZones) expect(CTX.zones).toContain(z);
    for (const h of s.searchSpots) expect(CTX.hideSpots).toContain(h);
    if (s.guardZone) expect(CTX.zones).toContain(s.guardZone);
  });

  it("leaves the player a route rather than covering the whole wing", () => {
    const m = new MimicMemory();
    for (let i = 0; i < 8; i++) runThrough(m, CTX.zones);
    const s = localStrategy(m, CTX);
    expect(s.patrolZones.length).toBeLessThan(CTX.zones.length);
  });

  it("covers the zone holding the next objective first", () => {
    const m = new MimicMemory();
    const s = localStrategy(m, CTX);
    expect(s.patrolZones[0]).toBe("power");
  });

  it("gets more skeptical of echo noise the more you bait with it", () => {
    const calm = new MimicMemory();
    runThrough(calm, ["start"]);
    runThrough(calm, ["start"]);
    const baseline = localStrategy(calm, CTX).echoSkepticism;

    const baited = new MimicMemory();
    for (let i = 0; i < 5; i++) {
      baited.noteStrategy("echo_bait");
      runThrough(baited, ["start"]);
    }
    expect(localStrategy(baited, CTX).echoSkepticism).toBeGreaterThan(baseline);
  });

  it("does not camp an objective before it has seen you at all", () => {
    const fresh = new MimicMemory();
    expect(localStrategy(fresh, CTX).guardZone).toBeNull();
  });

  it("does not follow you into the next session", () => {
    // Node has no localStorage, so stand one up — otherwise the check is vacuous.
    const store = new Map<string, string>();
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };

    try {
      const learned = new MimicMemory();
      for (let i = 0; i < 5; i++) {
        learned.noteStrategy("echo_bait");
        runThrough(learned, ["start", "west_hall"]);
      }
      expect(learned.data.runs).toBe(5);
      learned.save();

      // Reopening the game must face a MIMIC that has never met you.
      const reopened = MimicMemory.load();
      expect(reopened.data.runs).toBe(0);
      expect(reopened.data.echoStrategies.echo_bait ?? 0).toBe(0);
      expect(reopened.data.abilities).toEqual([]);
      // And the stale save is cleared rather than left to rot in storage.
      expect(store.size).toBe(0);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });

  it("gets more aggressive as the player nears the lift", () => {
    const m = new MimicMemory();
    const early = localStrategy(m, CTX).aggression;
    const late = localStrategy(m, {
      ...CTX,
      objectivesComplete: ["power", "auth", "containment"],
      nextObjective: "escape",
      objectiveZone: "escape",
      lockdown: true,
    }).aggression;
    expect(late).toBeGreaterThan(early);
  });
});
