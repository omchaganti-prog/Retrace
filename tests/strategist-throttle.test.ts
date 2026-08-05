/**
 * Remote planning is rate-limited.
 *
 * A run can end in a couple of seconds, and `plan()` runs on every restart. Left
 * unthrottled that was one model call per death — measured at 31 requests in
 * 5.7s of dying repeatedly, 29 of them aborted mid-flight. That billed for plans
 * nobody saw and ran the browser out of sockets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MimicMemory } from "../src/systems/memory";
import { Strategist, localStrategy } from "../src/systems/strategist";

const CTX = {
  zones: ["start", "power"],
  hideSpots: ["hide_a"],
  objectivesComplete: [] as string[],
  nextObjective: "power",
  objectiveZone: "power",
  lockdown: false,
};

/** Lets the test drive the clock the throttle reads. */
class TestStrategist extends Strategist {
  clock = 0;
  protected override now(): number {
    return this.clock;
  }
}

function fresh(): { s: TestStrategist; memory: MimicMemory } {
  const memory = new MimicMemory();
  return { s: new TestStrategist(localStrategy(memory, CTX)), memory };
}

/** Lets every pending promise settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote plan rate limiting", () => {
  it("fires once for a burst of restarts", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return { ok: true, json: async () => ({ ok: false, reason: "test" }) };
    });

    const { s, memory } = fresh();
    for (let i = 0; i < 30; i++) {
      s.clock += 120; // a death every 120ms
      s.plan(memory, CTX);
      await flush();
    }

    expect(calls).toBe(1);
  });

  it("allows another once the window has passed", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return { ok: true, json: async () => ({ ok: false, reason: "test" }) };
    });

    const { s, memory } = fresh();
    s.plan(memory, CTX);
    await flush();
    expect(calls).toBe(1);

    // A declined plan backs off further than the base interval, so jump well past it.
    s.clock += 10 * 60_000;
    s.plan(memory, CTX);
    await flush();
    expect(calls).toBe(2);
  });

  it("backs off further on each consecutive failure", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new Error("unreachable");
    });

    const { s, memory } = fresh();
    s.plan(memory, CTX);
    await flush();
    expect(calls).toBe(1);

    // The first wait is the 20s minimum interval, which is longer than the 15s
    // backoff base — the two are combined with a max, never stacked.
    s.clock += 21_000;
    s.plan(memory, CTX);
    await flush();
    expect(calls).toBe(2);

    // The second failure doubles to 30s, so the same 21s is no longer enough.
    s.clock += 21_000;
    s.plan(memory, CTX);
    await flush();
    expect(calls).toBe(2);

    // Waiting out the longer window lets it through again.
    s.clock += 15_000;
    s.plan(memory, CTX);
    await flush();
    expect(calls).toBe(3);
  });

  it("carries a remote plan into the next run instead of dropping to local", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        strategy: {
          source: "claude",
          patrolZones: ["power"],
          guardZone: "power",
          searchSpots: ["hide_a"],
          echoSkepticism: 0.5,
          aggression: 0.8,
          taunt: "SEEN",
          rationale: "test",
        },
      }),
    }));

    const { s, memory } = fresh();
    s.plan(memory, CTX);
    await flush();
    expect(s.current.source).toBe("claude");
    expect(s.link).toBe("claude");

    // Restarting must not throw the plan away and flicker the HUD back to LOCAL.
    s.clock += 1_000;
    const next = s.plan(memory, CTX);
    expect(next.source).toBe("claude");
    expect(s.link).toBe("claude");
  });

  it("lets a stale remote plan expire back to local", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls > 1) throw new Error("unreachable");
      return {
        ok: true,
        json: async () => ({
          ok: true,
          strategy: {
            source: "claude",
            patrolZones: ["power"],
            guardZone: null,
            searchSpots: [],
            echoSkepticism: 0.5,
            aggression: 0.8,
            taunt: "SEEN",
            rationale: "test",
          },
        }),
      };
    });

    const { s, memory } = fresh();
    s.plan(memory, CTX);
    await flush();
    expect(s.current.source).toBe("claude");

    // Well past the plan's shelf life.
    s.clock += 10 * 60_000;
    const stale = s.plan(memory, CTX);
    expect(stale.source).toBe("local");
  });
});
