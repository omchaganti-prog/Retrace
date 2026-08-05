/**
 * The client half of the MIMIC link.
 *
 * Two models produce the same shape. The local one is a deterministic reading of
 * the counters in MimicMemory and always runs; the remote one asks Claude (via
 * the Node-side route in server/mimic-strategist.mjs) for a better plan and
 * quietly replaces the local answer if it arrives in time.
 *
 * The game never waits on the network. `plan()` is fire-and-forget: the run
 * restarts immediately on the local strategy, and an upgraded plan lands
 * whenever it lands. Anything that goes wrong — no key, no server, slow,
 * malformed — leaves the local plan in place and shows "LOCAL" in the HUD.
 */
import { clamp } from "../core/math";
import type { MimicMemory } from "./memory";

/** Which planner produced the current strategy. */
export type StrategySource = "local" | "claude" | "openai";

export interface Strategy {
  source: StrategySource;
  /** Zone ids to patrol, most important first. */
  patrolZones: string[];
  /** Zone to camp near, or null to keep roaming. */
  guardZone: string | null;
  /** Hide-spot ids to sweep during a search, most likely first. */
  searchSpots: string[];
  /** 0..1 — how much noise made by ECHOs is discounted. */
  echoSkepticism: number;
  /** 0..1 — how committed it is to a chase versus resuming patrol. */
  aggression: number;
  taunt: string;
  rationale: string;
}

export interface StrategyContext {
  /** Vocabulary the planner may draw from. */
  zones: string[];
  hideSpots: string[];
  objectivesComplete: string[];
  nextObjective: string | null;
  /** Zone housing the next objective, if known. */
  objectiveZone: string | null;
  /** True once every objective is done and only the lift remains. */
  lockdown: boolean;
}

export type LinkState = "local" | "pending" | "claude" | "openai";

/** Remote sources the client will accept from the server. */
const REMOTE_SOURCES: readonly StrategySource[] = ["claude", "openai"];

const ENDPOINT =
  typeof __MIMIC_ENDPOINT__ === "string" ? __MIMIC_ENDPOINT__ : "/api/mimic/strategy";

/** Client-side ceiling. The server has its own; this covers a dead server too. */
const FETCH_TIMEOUT_MS = 13_000;

/**
 * Remote planning is rate-limited, because a run can end in seconds and used to
 * fire one model call per restart. Dying five times in a corridor produced five
 * requests, four of them aborted mid-flight — a request storm that ran the
 * browser out of sockets and billed for plans nobody ever saw.
 */
const MIN_REMOTE_INTERVAL_MS = 20_000;
/**
 * How long a remote plan stays good enough to carry into the next run. A plan is
 * a strategy, not a snapshot, so reusing it beats dropping back to local and
 * flickering the HUD between CLAUDE and LOCAL on every restart.
 */
const REMOTE_TTL_MS = 120_000;
/** Backoff after consecutive failures, doubling, so a dead endpoint goes quiet. */
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 300_000;

const TAUNTS = [
  "SUBJECT 047 RETURNED TO INVENTORY.",
  "YOU TOOK THAT CORRIDOR AGAIN.",
  "THE COPIES DO NOT HELP YOU.",
  "I HAVE SEEN THIS ATTEMPT BEFORE.",
  "PATTERN LOGGED. STABILITY DEGRADED.",
  "YOU ARE REPEATING YOURSELF.",
];

/**
 * Deterministic fallback planner.
 *
 * It counters rather than mirrors: the zones you use most get covered first,
 * heavy ECHO baiting raises skepticism, and aggression climbs as you approach
 * the lift. It deliberately never covers more than half the wing at once — a run
 * with no viable line is a bad run.
 */
export function localStrategy(memory: MimicMemory, ctx: StrategyContext): Strategy {
  const known = new Set(ctx.zones);
  const ranked = memory.rankedRoutes().filter((z) => known.has(z.id));
  const runs = memory.data.runs;

  const cap = Math.max(3, Math.min(5, Math.ceil(ctx.zones.length * 0.5)));
  const patrol: string[] = [];
  const push = (id: string | null): void => {
    if (!id || !known.has(id) || patrol.includes(id) || patrol.length >= cap) return;
    patrol.push(id);
  };

  // Cover the objective it expects you to want, then your habits, then filler so
  // an early run with no data still produces a real patrol.
  push(ctx.objectiveZone);
  for (const z of ranked) push(z.id);
  for (const z of ctx.zones) push(z);

  const bait = memory.strategyCount("echo_bait");
  const holds = memory.strategyCount("echo_hold") + memory.strategyCount("echo_multi_hold");
  const echoSkepticism = clamp((bait * 0.22 + holds * 0.08) * (runs > 1 ? 1 : 0.4), 0, 0.8);

  const aggression = clamp(
    0.18 + ctx.objectivesComplete.length * 0.17 + memory.data.catches * 0.035 + (ctx.lockdown ? 0.2 : 0),
    0,
    1,
  );

  return {
    source: "local",
    patrolZones: patrol,
    // Camping from the first run would be unfair; it needs to have seen you.
    guardZone: runs >= 2 ? ctx.objectiveZone : null,
    searchSpots: memory
      .rankedHides()
      .filter((h) => ctx.hideSpots.includes(h.id))
      .slice(0, 4)
      .map((h) => h.id),
    echoSkepticism,
    aggression,
    taunt: TAUNTS[Math.min(TAUNTS.length - 1, memory.data.catches)],
    rationale:
      ranked.length === 0
        ? "No route history yet — sweeping the wing broadly."
        : `Covering ${patrol.slice(0, 3).join(", ")}; you use them most.`,
  };
}

interface StrategyResponse {
  ok: boolean;
  reason?: string;
  strategy?: Omit<Strategy, "source"> & { source?: string };
}

export class Strategist {
  current: Strategy;
  link: LinkState = "local";
  /** Why the remote plan was not used, for the developer overlay. */
  lastReason: string | null = null;

  private inFlight: AbortController | null = null;
  private requestSeq = 0;
  /** The last plan a model actually returned, kept so restarts can reuse it. */
  private remote: Strategy | null = null;
  private remoteAt = Number.NEGATIVE_INFINITY;
  /** Earliest time another request may go out. */
  private nextAllowedAt = Number.NEGATIVE_INFINITY;
  private failures = 0;

  constructor(initial: Strategy) {
    this.current = initial;
  }

  /** Overridable for tests, which must not depend on the wall clock. */
  protected now(): number {
    return Date.now();
  }

  /**
   * Recompute the local plan immediately, then ask for an upgrade if the rate
   * limit allows one. Returns the plan the caller should start the run with —
   * never a promise.
   */
  plan(memory: MimicMemory, ctx: StrategyContext): Strategy {
    const now = this.now();

    if (this.remote && now - this.remoteAt <= REMOTE_TTL_MS) {
      this.current = this.remote;
      this.link = this.remote.source as LinkState;
    } else {
      this.remote = null;
      this.current = localStrategy(memory, ctx);
      this.link = "local";
    }

    if (now >= this.nextAllowedAt) void this.requestRemote(memory, ctx);
    return this.current;
  }

  private async requestRemote(memory: MimicMemory, ctx: StrategyContext): Promise<void> {
    if (typeof fetch !== "function") return;

    // Claim the window up front, so restarts during the flight cannot queue more.
    this.nextAllowedAt = this.now() + MIN_REMOTE_INTERVAL_MS;

    // A run can restart faster than the network answers; only the newest wins.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const seq = ++this.requestSeq;
    this.link = "pending";

    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          memory: memory.data,
          knowledge: memory.knowledge(),
          objectivesComplete: ctx.objectivesComplete,
          nextObjective: ctx.nextObjective,
          lockdown: ctx.lockdown,
          zones: ctx.zones,
          hideSpots: ctx.hideSpots,
        }),
      });
      if (seq !== this.requestSeq) return;

      if (!res.ok) {
        this.fallback(`http_${res.status}`);
        return;
      }
      const data = (await res.json()) as StrategyResponse;
      if (seq !== this.requestSeq) return;

      if (!data?.ok || !data.strategy) {
        this.fallback(data?.reason ?? "declined");
        return;
      }
      // The server already clamps and filters against the vocabulary; this is a
      // shape check, not a trust boundary re-run. The source decides the HUD
      // label, so pin it to a known provider rather than trusting the string.
      const source = REMOTE_SOURCES.find((s) => s === data.strategy?.source) ?? "claude";
      this.current = { ...data.strategy, source };
      this.remote = this.current;
      this.remoteAt = this.now();
      this.failures = 0;
      this.link = source;
      this.lastReason = null;
    } catch (err) {
      if (seq !== this.requestSeq) return;
      this.fallback((err as Error)?.name === "AbortError" ? "timeout" : "unreachable");
    } finally {
      clearTimeout(timer);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private fallback(reason: string): void {
    this.link = "local";
    this.lastReason = reason;
    // Back off hard on a dead or unhappy endpoint rather than retrying every
    // restart forever. Doubles per consecutive failure, capped.
    this.failures++;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + wait);
  }
}
