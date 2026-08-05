/**
 * MIMIC's memory of you.
 *
 * This is the data model from the design brief: counters for the routes you
 * take, the corners you hide in, and the ECHO tactics you lean on. It survives
 * resets — including Temporal Collapse, which only decays it — because the
 * whole premise is that the thing hunting you remembers what you did even when
 * the facility does not.
 *
 * That premise stops at the tab, though. See PERSIST_MEMORY: closing the game
 * wipes the slate, so a fresh session always faces a naive MIMIC rather than one
 * that has been quietly reading you for days.
 *
 * Kept free of DOM APIs except for a guarded localStorage read/write, so it can
 * be exercised under Node.
 */

import { type AdaptationValues, emptyAdaptation } from "../ai/adaptation";

export type StrategyId =
  /** An ECHO's noise pulled MIMIC away from the player. */
  | "echo_bait"
  /** An ECHO was parked on a pressure plate. */
  | "echo_hold"
  /** Two or more plates were held at once. */
  | "echo_multi_hold"
  /** The player sprinted deliberately while MIMIC was in earshot. */
  | "sprint_lure"
  /** The player waited out a search inside a shadow alcove. */
  | "shadow_wait";

export type RunOutcome = "retrace" | "caught" | "collapse" | "objective" | "escape";

export interface RunSummary {
  run: number;
  outcome: RunOutcome;
  /** Zones entered, in order, deduplicated against immediate repeats. */
  route: string[];
  hides: string[];
  strategies: StrategyId[];
  objectivesDone: string[];
  seconds: number;
}

export interface MimicMemoryData {
  version: number;
  runs: number;
  catches: number;
  collapses: number;
  escapes: number;
  routeCounts: Record<string, number>;
  hideCounts: Record<string, number>;
  echoStrategies: Record<string, number>;
  /** Which zone you were heading for when it caught you. */
  catchZones: Record<string, number>;
  /** The most recent runs, newest last. Fed to the strategist. */
  recent: RunSummary[];
  /**
   * Behaviour counters driving MIMIC's adaptations. Survives everything,
   * including Temporal Collapse — the facility resets, MIMIC does not.
   */
  adaptation: AdaptationValues;
  /** Counter-measures it has developed. Never un-learned. */
  abilities: string[];
}

const STORAGE_KEY = "retrace.mimic.v1";
const VERSION = 2;
const RECENT_LIMIT = 8;

/**
 * Whether MIMIC's memory outlives the browser tab. Off: every time you open the
 * game it starts naive, and everything it learns about you lasts only as long as
 * the session. Flip to true to restore the brief's original cross-session hunter.
 */
const PERSIST_MEMORY = false;

function emptyData(): MimicMemoryData {
  return {
    version: VERSION,
    runs: 0,
    catches: 0,
    collapses: 0,
    escapes: 0,
    routeCounts: {},
    hideCounts: {},
    echoStrategies: {},
    catchZones: {},
    recent: [],
    adaptation: emptyAdaptation(),
    abilities: [],
  };
}

const bump = (m: Record<string, number>, k: string, by = 1): void => {
  m[k] = (m[k] ?? 0) + by;
};

export class MimicMemory {
  data: MimicMemoryData;

  /** Accumulators for the run currently in progress. */
  private route: string[] = [];
  private hides = new Set<string>();
  private strategies = new Set<StrategyId>();

  constructor(data?: MimicMemoryData) {
    this.data = data ?? emptyData();
  }

  /* ----------------------------------------------------- live run tracking */

  noteZone(zoneId: string | null): void {
    if (!zoneId) return;
    if (this.route[this.route.length - 1] === zoneId) return;
    this.route.push(zoneId);
  }

  noteHide(spotId: string): void {
    this.hides.add(spotId);
  }

  noteStrategy(id: StrategyId): void {
    this.strategies.add(id);
  }

  get currentRoute(): readonly string[] {
    return this.route;
  }

  /* --------------------------------------------------------- run outcomes */

  endRun(outcome: RunOutcome, objectivesDone: string[], seconds: number, atZone: string | null): RunSummary {
    const summary: RunSummary = {
      run: this.data.runs + 1,
      outcome,
      route: this.route.slice(),
      hides: [...this.hides],
      strategies: [...this.strategies],
      objectivesDone: objectivesDone.slice(),
      seconds: Math.round(seconds * 10) / 10,
    };

    this.data.runs++;
    for (const z of summary.route) bump(this.data.routeCounts, z);
    for (const h of summary.hides) bump(this.data.hideCounts, h);
    for (const s of summary.strategies) bump(this.data.echoStrategies, s);
    if (outcome === "caught" || outcome === "collapse") {
      this.data.catches++;
      if (atZone) bump(this.data.catchZones, atZone);
    }
    if (outcome === "collapse") this.data.collapses++;
    if (outcome === "escape") this.data.escapes++;

    this.data.recent.push(summary);
    if (this.data.recent.length > RECENT_LIMIT) this.data.recent.shift();

    this.route = [];
    this.hides.clear();
    this.strategies.clear();
    return summary;
  }

  /**
   * Temporal Collapse rewrites the facility but only partially clears MIMIC.
   * The brief calls for its knowledge to "drop partially" — the shape of what
   * it learned survives, the sharpness does not.
   */
  decayOnCollapse(factor = 0.82): void {
    for (const m of [this.data.routeCounts, this.data.hideCounts, this.data.echoStrategies]) {
      for (const k of Object.keys(m)) {
        m[k] = Math.round(m[k] * factor * 10) / 10;
        if (m[k] < 0.2) delete m[k];
      }
    }
  }

  /* ------------------------------------------------------------- readouts */

  /** Zones sorted by how often you have been through them. */
  rankedRoutes(): { id: string; count: number }[] {
    return Object.entries(this.data.routeCounts)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }

  rankedHides(): { id: string; count: number }[] {
    return Object.entries(this.data.hideCounts)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }

  strategyCount(id: StrategyId): number {
    return this.data.echoStrategies[id] ?? 0;
  }

  /**
   * 0..100. Not a difficulty slider — a readout of how much of your behaviour
   * it has actually seen. Shown in the HUD because the tension only works if
   * you can watch the number climb.
   */
  knowledge(): number {
    const d = this.data;
    const routeMass = Object.values(d.routeCounts).reduce((a, b) => a + b, 0);
    const distinctRoutes = Object.keys(d.routeCounts).length;
    const strategyMass = Object.values(d.echoStrategies).reduce((a, b) => a + b, 0);
    const hideMass = Object.values(d.hideCounts).reduce((a, b) => a + b, 0);
    const score =
      Math.min(34, routeMass * 1.1) +
      Math.min(18, distinctRoutes * 2.6) +
      Math.min(26, strategyMass * 3.4) +
      Math.min(12, hideMass * 2.2) +
      Math.min(10, d.catches * 1.6);
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /* ---------------------------------------------------------- persistence */

  save(): void {
    if (!PERSIST_MEMORY) return;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable (private mode, Node) — memory stays in-process */
    }
  }

  static load(): MimicMemory {
    // Opening the game is a clean slate: MIMIC still remembers everything you do
    // across retraces and collapses within a session, but not across sessions.
    if (!PERSIST_MEMORY) {
      MimicMemory.wipe();
      return new MimicMemory();
    }
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MimicMemoryData;
        if (parsed?.version === VERSION) return new MimicMemory({ ...emptyData(), ...parsed });
      }
    } catch {
      /* fall through to a fresh memory */
    }
    return new MimicMemory();
  }

  static wipe(): void {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}
