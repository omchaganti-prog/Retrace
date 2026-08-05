/**
 * Dynamic score and Hunt Mode.
 *
 * The score is a gameplay signal, so it is tested like one: proximity has to
 * move it through walls, sight has to move it faster, and relief has to be slow
 * enough that a search still feels dangerous.
 */
import { describe, expect, it } from "vitest";
import { AlertManager } from "../src/game/alert";
import { Game } from "../src/game/game";
import { HUNT, HuntManager } from "../src/game/hunt";
import { MUSIC_STEMS, MusicManager, type StemId, type ThreatSnapshot } from "../src/systems/music";
import { TICK_DT } from "../src/core/constants";
import { tileCenter } from "../src/world/level";
import { FakeInput } from "./helpers";

const FAR = tileCenter(63, 43);

const threat = (over: Partial<ThreatSnapshot> = {}): ThreatSnapshot => ({
  distanceTiles: 40,
  hasLineOfSight: false,
  detected: false,
  chasing: false,
  hunting: false,
  corruption: 0,
  ...over,
});

/** Advances the score without audio — the intensity model is pure. */
function run(music: MusicManager, seconds: number, los = false): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) music.update(TICK_DT, los);
}

describe("intensity responds to proximity", () => {
  it("stays calm when MIMIC is far away", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 40 }));
    run(m, 3);
    expect(m.intensity).toBeLessThan(0.3);
  });

  it("rises as MIMIC closes in, with no line of sight at all", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 16 }));
    run(m, 4);
    const nearby = m.intensity;

    m.setThreat(threat({ distanceTiles: 5 }));
    run(m, 4);

    // This is the whole point: the music warned you through a wall.
    expect(nearby).toBeGreaterThan(0.4);
    expect(m.intensity).toBeGreaterThan(nearby);
  });

  it("climbs faster when MIMIC actually has eyes on you", () => {
    const blind = new MusicManager();
    blind.setThreat(threat({ distanceTiles: 4, detected: true }));
    run(blind, 0.4, false);

    const seen = new MusicManager();
    seen.setThreat(threat({ distanceTiles: 4, detected: true }));
    run(seen, 0.4, true);

    expect(seen.intensity).toBeGreaterThan(blind.intensity);
  });

  it("reaches the hunt band only during a hunt", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true }));
    run(m, 6);
    expect(m.mix().hunt).toBe(0);

    m.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true, hunting: true }));
    run(m, 4);
    expect(m.mix().hunt).toBeGreaterThan(0.5);
  });
});

describe("relief is slow and can be false", () => {
  it("holds its ground for a moment before easing down at all", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 3, detected: true, chasing: true }));
    run(m, 4);
    const peak = m.intensity;

    // The threat is gone, but the room has not settled yet.
    m.setThreat(threat({ distanceTiles: 40 }));
    run(m, 1.2);
    expect(m.intensity).toBe(peak);

    // Only after the hold does it begin to let go.
    run(m, 3);
    expect(m.intensity).toBeLessThan(peak);
  });

  it("takes far longer to calm than to build", () => {
    const up = new MusicManager();
    up.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true }));
    let riseTicks = 0;
    while (up.intensity < 4 && riseTicks < 60 * 60) {
      up.update(TICK_DT);
      riseTicks++;
    }

    const down = new MusicManager();
    down.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true }));
    run(down, 6);
    down.setThreat(threat({ distanceTiles: 40 }));
    let fallTicks = 0;
    while (down.intensity > 0.5 && fallTicks < 60 * 120) {
      down.update(TICK_DT);
      fallTicks++;
    }

    // The exhale should be many times longer than the inhale.
    expect(fallTicks).toBeGreaterThan(riseTicks * 5);
  });

  it("does not calm the instant MIMIC loses you", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 3, detected: true, chasing: true }));
    run(m, 4);
    const peak = m.intensity;

    m.setThreat(threat({ distanceTiles: 30 }));
    m.onLostSight();
    run(m, 1);

    // A search still has to sound dangerous.
    expect(m.intensity).toBeGreaterThan(peak * 0.5);
  });

  it("rises again when MIMIC closes back in — the false relief", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 3, detected: true, chasing: true }));
    run(m, 4);
    const peak = m.intensity;

    // Escaped. The score holds its ground briefly, then lets go slowly — the
    // full exhale takes ~20s, so relief needs a real window to be audible.
    m.setThreat(threat({ distanceTiles: 30 }));
    run(m, 12);
    const relaxed = m.intensity;

    // MIMIC predicted the route and is closing again — still unseen.
    m.setThreat(threat({ distanceTiles: 6 }));
    run(m, 3);

    // It let go of a meaningful amount before pulling back — that gap is the
    // relief, and the recovery is what makes it false.
    expect(peak - relaxed).toBeGreaterThan(1.5);
    expect(m.intensity).toBeGreaterThan(relaxed);
  });

  it("falls more slowly than it rises", () => {
    const up = new MusicManager();
    up.setThreat(threat({ distanceTiles: 2, detected: true }));
    run(up, 1);

    const down = new MusicManager();
    down.setThreat(threat({ distanceTiles: 2, detected: true }));
    run(down, 6);
    const before = down.intensity;
    down.setThreat(threat({ distanceTiles: 40 }));
    run(down, 1);
    const dropped = before - down.intensity;

    expect(up.intensity).toBeGreaterThan(dropped);
  });
});

describe("layers crossfade rather than switch", () => {
  it("never leaves the mix silent while playing", () => {
    const m = new MusicManager();
    for (const d of [40, 20, 12, 6, 2]) {
      m.setThreat(threat({ distanceTiles: d }));
      run(m, 2);
      const mix = m.mix();
      const total = MUSIC_STEMS.reduce((sum: number, id: StemId) => sum + mix[id], 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  it("keeps two layers overlapping through a transition", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 8 }));
    run(m, 4);
    const mix = m.mix();
    const audible = MUSIC_STEMS.filter((id: StemId) => mix[id] > 0.01);
    expect(audible.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps ambient present at every intensity", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 1, detected: true, chasing: true, hunting: true }));
    run(m, 6);
    expect(m.mix().ambient).toBeGreaterThan(0.3);
  });
});

describe("intensity is arrangement, not volume", () => {
  it("adds instruments as it builds", () => {
    const m = new MusicManager();
    const counts: number[] = [];
    for (const d of [40, 20, 12, 6]) {
      m.setThreat(threat({ distanceTiles: d }));
      run(m, 6);
      counts.push(m.activeStems());
    }
    // Each step closer brings more of the composition in.
    expect(counts[0]).toBe(1); // ambient alone
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
  });

  it("brings the full arrangement in only at hunt intensity", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true }));
    run(m, 8);
    const chase = m.activeStems();

    m.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true, hunting: true }));
    run(m, 8);

    expect(m.activeStems()).toBeGreaterThan(chase);
    expect(m.activeStems()).toBe(MUSIC_STEMS.length);
  });

  it("opens the filter as it builds — the build without the loudness", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 40 }));
    run(m, 3);
    const calm = m.brightness();

    m.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true }));
    run(m, 5);

    expect(calm).toBeLessThan(0.2);
    expect(m.brightness()).toBeGreaterThan(0.7);
  });

  it("holds tempo fixed so the stems stay synchronised", () => {
    // A stem system that changes BPM cannot stay in sync — this was the bug in
    // the first implementation, which scaled step duration with intensity.
    // Energy must come from density instead.
    const calm = new MusicManager();
    calm.setThreat(threat({ distanceTiles: 40 }));
    run(calm, 30);

    const frantic = new MusicManager();
    frantic.setThreat(threat({ distanceTiles: 1, detected: true, chasing: true, hunting: true }));
    run(frantic, 30);

    // Same wall-clock, same number of bars, at opposite ends of the intensity
    // range. The grid is immovable.
    expect(frantic.bars).toBe(calm.bars);
    expect(calm.bars).toBeGreaterThan(5);
  });

  it("introduces the MIMIC motif only when it is genuinely close", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 20 }));
    run(m, 6);
    expect(m.mix().mimic).toBe(0);

    m.setThreat(threat({ distanceTiles: 4 }));
    run(m, 8);
    expect(m.mix().mimic).toBeGreaterThan(0);
  });

  it("layers the arrangement in a musical order", () => {
    const m = new MusicManager();
    const entryOrder: StemId[] = [];
    const record = (): void => {
      for (const id of MUSIC_STEMS) {
        if (m.mix()[id] > 0 && !entryOrder.includes(id)) entryOrder.push(id);
      }
    };
    for (let d = 40; d >= 1; d -= 2) {
      m.setThreat(threat({ distanceTiles: d, detected: d < 4, chasing: d < 3 }));
      run(m, 4);
      record();
    }
    // The emergency stem is hunt-exclusive, so it can only arrive last.
    m.setThreat(threat({ distanceTiles: 1, detected: true, chasing: true, hunting: true }));
    run(m, 6);
    record();
    // Foundation first, then rhythm, then the aggressive parts.
    expect(entryOrder[0]).toBe("ambient");
    expect(entryOrder.indexOf("bass")).toBeLessThan(entryOrder.indexOf("chase"));
    expect(entryOrder.indexOf("percussion")).toBeLessThan(entryOrder.indexOf("chase"));
    expect(entryOrder[entryOrder.length - 1]).toBe("hunt");
  });

  it("does not flicker a stem in and out on the threshold", () => {
    const m = new MusicManager();
    // Park intensity right on the bass entry point.
    m.setThreat(threat({ distanceTiles: 26 - 0.8 * 6 }));
    run(m, 6);
    const first = m.mix().bass;
    let flips = 0;
    let prev = first;
    for (let i = 0; i < 40; i++) {
      run(m, 0.5);
      const now = m.mix().bass;
      if (now !== prev) flips++;
      prev = now;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });
});

describe("temporal corruption", () => {
  it("collapses to silence and rebuilds from nothing", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 2, detected: true, chasing: true }));
    run(m, 4);
    expect(m.intensity).toBeGreaterThan(1);

    m.onCollapse();
    run(m, 0.5);
    const mix = m.mix();
    expect(MUSIC_STEMS.every((id: StemId) => mix[id] === 0)).toBe(true);

    m.onRestore();
    run(m, 0.2);
    expect(m.intensity).toBe(0);
    expect(m.mix().ambient).toBeGreaterThan(0);
  });

  it("mutes everything without tearing down the graph", () => {
    const m = new MusicManager();
    m.setThreat(threat({ distanceTiles: 2 }));
    run(m, 3);
    m.muted = true;
    const mix = m.mix();
    expect(MUSIC_STEMS.every((id: StemId) => mix[id] === 0)).toBe(true);
    m.muted = false;
    expect(m.mix().ambient).toBeGreaterThan(0);
  });
});

describe("hunt manager", () => {
  it("starts only for a stated reason and runs a bounded timer", () => {
    const h = new HuntManager();
    expect(h.active).toBe(false);
    expect(h.start("objective")).toBe(true);
    expect(h.active).toBe(true);
    expect(h.reason).toBe("objective");
    expect(h.remaining).toBeLessThanOrEqual(HUNT.duration);
  });

  it("ends on its own — the player survives it, not endures it", () => {
    const h = new HuntManager();
    h.start("objective");
    for (let i = 0; i < Math.round((HUNT.duration + 1) / TICK_DT); i++) h.tick(TICK_DT);
    expect(h.active).toBe(false);
    expect(h.bonus.active).toBe(false);
  });

  it("refuses to restart while one is running or cooling down", () => {
    const h = new HuntManager();
    h.start("objective");
    expect(h.start("alarm")).toBe(false);
    for (let i = 0; i < Math.round((HUNT.duration + 1) / TICK_DT); i++) h.tick(TICK_DT);
    // Cooldown holds it off.
    expect(h.start("alarm")).toBe(false);
  });

  it("hands MIMIC bounded multipliers and nothing else", () => {
    const h = new HuntManager();
    h.start("objective");
    const b = h.bonus;
    expect(b.speed).toBeGreaterThan(1);
    expect(b.speed).toBeLessThan(1.35);
    expect(b.search).toBeLessThan(2);
    expect(b.persistence).toBeLessThan(2);
    // Multipliers only — no senses, no knowledge, no teleport.
    expect(Object.keys(b).sort()).toEqual(["active", "persistence", "search", "speed"]);
  });

  it("clears on a run restart", () => {
    const h = new HuntManager();
    h.start("objective");
    h.resetForRun();
    expect(h.active).toBe(false);
  });
});

describe("alert manager", () => {
  it("ramps emergency lighting instead of snapping", () => {
    const a = new AlertManager();
    a.update(TICK_DT, 1);
    expect(a.emergency).toBeGreaterThan(0);
    expect(a.emergency).toBeLessThan(0.2);
  });

  it("calms more slowly than it panics", () => {
    const a = new AlertManager();
    for (let i = 0; i < 120; i++) a.update(TICK_DT, 1);
    const up = a.emergency;
    const before = a.emergency;
    for (let i = 0; i < 30; i++) a.update(TICK_DT, 0);
    const droppedIn = before - a.emergency;

    const b = new AlertManager();
    for (let i = 0; i < 30; i++) b.update(TICK_DT, 1);
    expect(up).toBeGreaterThan(0.9);
    expect(b.emergency).toBeGreaterThan(droppedIn);
  });

  it("flattens the strobe under reduced motion", () => {
    const flashing = new AlertManager();
    const steady = new AlertManager();
    steady.reducedFlashing = true;

    let min = 1;
    let max = 0;
    let steadyMin = 1;
    let steadyMax = 0;
    for (let i = 0; i < 300; i++) {
      flashing.update(TICK_DT, 1);
      steady.update(TICK_DT, 1);
      if (flashing.emergency > 0.95) {
        min = Math.min(min, flashing.strobe);
        max = Math.max(max, flashing.strobe);
        steadyMin = Math.min(steadyMin, steady.strobe);
        steadyMax = Math.max(steadyMax, steady.strobe);
      }
    }
    // Same information, far less flicker.
    expect(max - min).toBeGreaterThan(0.3);
    expect(steadyMax - steadyMin).toBeLessThan
      (0.05);
  });

  it("never chatters — announcements queue and dedupe", () => {
    const a = new AlertManager();
    a.announce("FACILITY ALERT LEVEL: MAXIMUM");
    a.announce("FACILITY ALERT LEVEL: MAXIMUM");
    a.update(TICK_DT, 1);
    expect(a.current?.text).toBe("FACILITY ALERT LEVEL: MAXIMUM");

    a.announce("SUBJECT 047 LOCATED");
    a.update(TICK_DT, 1);
    // The second waits its turn rather than stomping the first.
    expect(a.current?.text).toBe("FACILITY ALERT LEVEL: MAXIMUM");
  });
});

describe("hunt mode in the live game", () => {
  it("triggers when a major system comes online", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);

    // The reactor interlock is dead until the generator intake is cleared;
    // that stage is proven for real in puzzles.test.ts.
    game.objectives.add("intake");
    const lever = game.level.propById.get("reactor_lever")!;
    const c = tileCenter(lever.tx, lever.ty);
    game.player.reset(c.x, c.y);
    input.press("KeyE");
    game.tick(TICK_DT, input.asInput());

    expect(game.objectives.has("power")).toBe(true);
    expect(game.hunt.active).toBe(true);
    expect(game.hunt.reason).toBe("objective");
  });

  it("leaves justStarted observable after the tick returns", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);

    // The reactor interlock is dead until the generator intake is cleared;
    // that stage is proven for real in puzzles.test.ts.
    game.objectives.add("intake");
    const lever = game.level.propById.get("reactor_lever")!;
    const c = tileCenter(lever.tx, lever.ty);
    game.player.reset(c.x, c.y);
    input.press("KeyE");
    game.tick(TICK_DT, input.asInput());

    // The hunt begins early in the tick. Clearing the flag at the end of that
    // same tick made it permanently invisible to anything outside the Game.
    expect(game.hunt.active).toBe(true);
    expect(game.hunt.justStarted).toBe(true);
    expect(game.hunt.count).toBe(1);

    // And it is gone by the next tick, not sticky.
    game.tick(TICK_DT, input.asInput());
    expect(game.hunt.justStarted).toBe(false);
  });

  it("can escalate from adaptation without every objective done", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    // Previously this also required lockdown — all three systems — which made
    // it unreachable for almost the whole game.
    for (const k of ["routeDependency", "echoDependency", "noiseDependency"] as const) {
      game.adaptation.note(k, 100);
    }
    expect(game.lockdown).toBe(false);

    for (let i = 0; i < 120 && !game.hunt.active; i++) {
      game.mimic.reset(FAR.x, FAR.y);
      game.tick(TICK_DT, input.asInput());
    }
    expect(game.hunt.active).toBe(true);
    expect(game.hunt.reason).toBe("adaptation");
  });

  it("raises emergency lighting and then stands down", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    game.hunt.start("objective");
    (game as unknown as { onHuntStarted(): void }).onHuntStarted();

    for (let i = 0; i < 120; i++) game.tick(TICK_DT, input.asInput());
    expect(game.alert.emergency).toBeGreaterThan(0.5);

    for (let i = 0; i < Math.round((HUNT.duration + 4) / TICK_DT); i++) {
      game.mimic.reset(FAR.x, FAR.y);
      game.tick(TICK_DT, input.asInput());
    }
    expect(game.hunt.active).toBe(false);
    expect(game.alert.emergency).toBeLessThan(0.5);
  });

  it("cannot strand the player behind the doors it seals", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    game.hunt.start("objective");
    (game as unknown as { onHuntStarted(): void }).onHuntStarted();
    game.tick(TICK_DT, input.asInput());

    // The same reachability guard as Door Control applies to hunt locks.
    const canFinish = (game as unknown as { playerCanStillFinish(): boolean }).playerCanStillFinish();
    expect(canFinish).toBe(true);
  });

  it("leaves ECHOs and RETRACE fully functional during a hunt", () => {
    const game = new Game();
    const input = new FakeInput();
    game.mimic.reset(FAR.x, FAR.y);
    game.hunt.start("objective");

    input.hold("KeyR");
    for (let i = 0; i < 150 && game.run === 1; i++) {
      game.mimic.reset(FAR.x, FAR.y);
      game.tick(TICK_DT, input.asInput());
    }
    input.release("KeyR");

    expect(game.run).toBe(2);
    expect(game.echoes.count).toBe(1);
  });
});
