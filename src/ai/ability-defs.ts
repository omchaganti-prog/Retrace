/**
 * The concrete adaptations.
 *
 * Each one is small on purpose: the manager owns power, cooldowns and
 * selection, so an ability only has to answer "is now the moment?" and "what do
 * I do?". None of them may read state the level would not legitimately expose.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import { TILE } from "../core/constants";
import { dist } from "../core/math";
import { tileCenter } from "../world/level";
import type { Ability, AbilityCtx, AbilityId } from "./abilities";
import type { AnalysisBook } from "./analysis";

/** Deep Scan reports sectors this many tiles across, never exact positions. */
const SECTOR_TILES = 3;
/** How far MIMIC will reach to seal a door, in tiles. */
const DOOR_REACH_TILES = 14;

const sectorCentre = (x: number, y: number): { x: number; y: number } => {
  const size = TILE * SECTOR_TILES;
  return {
    x: Math.floor(x / size) * size + size / 2,
    y: Math.floor(y / size) * size + size / 2,
  };
};

/* ------------------------------------------------------------- FOCUS SCAN */

/**
 * Stop and sweep. The advantage is honest: a stationary wide sweep covers far
 * more ground than a walking glance, so it is more likely to actually catch you
 * with the ordinary line-of-sight check. It reveals nothing through a wall.
 */
class FocusScan implements Ability {
  readonly id: AbilityId = "focus_scan";
  private centre = 0;

  ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.holdT > 0) return false;
    if (ctx.mimic.state === "chase") return false;
    // Chasing aside, it will stop and sweep from any state — including patrol.
    // A patrolling MIMIC that never does anything makes the whole adaptation
    // system invisible, and sweeping a corridor it is already walking is the
    // most natural thing it can do.
    if (ctx.mimic.state === "investigate" || ctx.mimic.state === "alert") {
      return ctx.mimic.lastKnown !== null && ctx.mimic.unseenT > 0.6;
    }
    return true;
  }

  activate(ctx: AbilityCtx): number {
    // With a lead, sweep across it. On patrol, sweep across where it is looking.
    const target = ctx.mimic.lastKnown;
    this.centre = target
      ? Math.atan2(target.y - ctx.mimic.y, target.x - ctx.mimic.x)
      : ctx.mimic.facing;
    ctx.mimic.holdT = 2.1;
    ctx.world.emitFx({ kind: "scan", x: ctx.mimic.x, y: ctx.mimic.y, radius: TILE * 7, life: 2.1 });
    ctx.world.play("scan", 0.4);
    return 2.1;
  }

  update(ctx: AbilityCtx, elapsed: number): void {
    // Slow deliberate sweep across the suspect arc.
    ctx.mimic.facing = this.centre + Math.sin(elapsed * 2.4) * 1.1;
    ctx.mimic.holdT = Math.max(ctx.mimic.holdT, 0.05);
  }
}

/* --------------------------------------------------------- SOUND ANALYSIS */

/** Passive. Turns the familiarity ledger on for noises. */
class SoundAnalysis implements Ability {
  readonly id: AbilityId = "sound_analysis";
  constructor(private readonly book: AnalysisBook) {}
  ready(): boolean {
    return false;
  }
  activate(): number {
    return 0;
  }
  passive(): void {
    this.book.soundAnalysisActive = true;
  }
}

/* ---------------------------------------------------------- ECHO ANALYSIS */

/** Passive. Same, for repeated ECHO behaviour. */
class EchoAnalysis implements Ability {
  readonly id: AbilityId = "echo_analysis";
  constructor(private readonly book: AnalysisBook) {}
  ready(): boolean {
    return false;
  }
  activate(): number {
    return 0;
  }
  passive(): void {
    this.book.echoAnalysisActive = true;
  }
}

/* ------------------------------------------------------- ROUTE PREDICTION */

/**
 * Guess where you are heading from where you have habitually gone, and cut that
 * way instead of following. It picks from your top few zones by weight, so it is
 * regularly wrong — which is the point. A route you have never used is invisible
 * to it, and an ECHO walking your old line will pull it perfectly.
 */
class RoutePrediction implements Ability {
  readonly id: AbilityId = "route_prediction";

  protected candidates(ctx: AbilityCtx): { id: string; count: number }[] {
    const zones = new Set(ctx.world.level.zones.map((z) => z.id));
    return ctx.memory
      .rankedRoutes()
      .filter((r) => zones.has(r.id) && r.id !== ctx.player.zone)
      .slice(0, 3);
  }

  ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.state !== "chase" && ctx.mimic.state !== "investigate") return false;
    if (ctx.mimic.unseenT > 6) return false;
    const top = this.candidates(ctx);
    return top.length >= 2 && top[0].count >= 3;
  }

  activate(ctx: AbilityCtx): number {
    const top = this.candidates(ctx);
    // Weighted, not greedy: MIMIC commits to a plausible guess, not the truth.
    const pick = top[ctx.rng.weightedIndex(top.map((t) => t.count))];
    const centre = ctx.world.level.zoneCenter(pick.id);
    if (!centre) return 0;

    ctx.mimic.commandGoal(centre.x, centre.y);
    ctx.world.emitFx({
      kind: "predict",
      x: ctx.mimic.x,
      y: ctx.mimic.y,
      toX: centre.x,
      toY: centre.y,
      radius: TILE * 2,
      life: 1.2,
    });
    ctx.world.play("link", 0.3);
    return 0;
  }
}

/* -------------------------------------------------------------- INTERCEPT */

/**
 * Route Prediction with commitment: pick a chokepoint on the way to the guessed
 * destination and wait there rather than trailing behind. It walks — it never
 * teleports — so doubling back beats it outright.
 */
class Intercept extends RoutePrediction implements Ability {
  override readonly id: AbilityId = "intercept";

  override ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.state !== "chase" && ctx.mimic.state !== "investigate") return false;
    if (ctx.mimic.unseenT > 4) return false;
    const top = this.candidates(ctx);
    return top.length >= 1 && top[0].count >= 4;
  }

  override activate(ctx: AbilityCtx): number {
    const top = this.candidates(ctx);
    const pick = top[ctx.rng.weightedIndex(top.map((t) => t.count))];
    const dest = ctx.world.level.zoneCenter(pick.id);
    const from = ctx.mimic.lastKnown ?? { x: ctx.player.x, y: ctx.player.y };
    if (!dest) return 0;

    // A chokepoint is a real map feature — a hatch or patrol node closest to the
    // straight line between where you were and where it thinks you are going.
    const level = ctx.world.level;
    const nodes = [
      ...level.doors.map((d) => tileCenter(d.tx, d.ty)),
      ...level.patrolNodes.map((n) => tileCenter(n.tx, n.ty)),
    ];
    let best = dest;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const n of nodes) {
      const detour = dist(from.x, from.y, n.x, n.y) + dist(n.x, n.y, dest.x, dest.y);
      const direct = dist(from.x, from.y, dest.x, dest.y);
      // Prefer points genuinely on the way, and reachable before the player.
      const score = detour - direct + dist(ctx.mimic.x, ctx.mimic.y, n.x, n.y) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }

    ctx.mimic.beginIntercept(best.x, best.y, 7);
    ctx.world.emitFx({
      kind: "intercept",
      x: ctx.mimic.x,
      y: ctx.mimic.y,
      toX: best.x,
      toY: best.y,
      radius: TILE * 2,
      life: 1.4,
    });
    ctx.world.play("link", 0.4);
    return 0;
  }
}

/* ----------------------------------------------------------- DOOR CONTROL */

/**
 * Seal a hatch across your line. Only doors the facility lets it touch, only
 * temporarily, and only when the game can prove you are not stranded by it —
 * the reachability check lives in the Game so a lock can never softlock a run.
 */
class DoorControl implements Ability {
  readonly id: AbilityId = "door_control";
  private target: string | null = null;

  ready(ctx: AbilityCtx): boolean {
    // Alert counts as well as chase. Chase alone is about 1% of MIMIC's time,
    // which made this effectively unreachable in real play.
    const hunting =
      ctx.mimic.state === "chase" ||
      ctx.mimic.state === "intercept" ||
      ctx.mimic.state === "alert";
    if (!hunting) return false;
    this.target = null;
    const reach = DOOR_REACH_TILES * TILE;
    const aim = ctx.mimic.lastKnown ?? { x: ctx.player.x, y: ctx.player.y };
    let bestD = reach;
    for (const id of ctx.world.lockableDoors()) {
      const d = ctx.world.level.doorById.get(id);
      if (!d) continue;
      const c = tileCenter(d.tx, d.ty);
      const gap = dist(aim.x, aim.y, c.x, c.y);
      if (gap < bestD) {
        bestD = gap;
        this.target = id;
      }
    }
    return this.target !== null;
  }

  activate(ctx: AbilityCtx): number {
    if (!this.target) return 0;
    const d = ctx.world.level.doorById.get(this.target);
    if (!d || !ctx.world.lockDoor(this.target, 6.5)) return 0;
    const c = tileCenter(d.tx, d.ty);
    ctx.world.emitFx({
      kind: "lock",
      x: ctx.mimic.x,
      y: ctx.mimic.y,
      toX: c.x,
      toY: c.y,
      radius: TILE,
      life: 0.9,
    });
    ctx.world.play("lock", 0.55);
    ctx.world.notice("SECURITY OVERRIDE");
    return 0;
  }
}

/* ------------------------------------------------------------ CAMERA LINK */

/**
 * Read the facility's own cameras. It learns only what a camera actually saw,
 * and a camera cannot tell a copy from the original — so walking an ECHO through
 * a cone feeds MIMIC a genuine, genuinely wrong report.
 */
class CameraLink implements Ability {
  readonly id: AbilityId = "camera_link";

  ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.state === "chase") return false;
    return ctx.world.cameraSightings().length > 0;
  }

  activate(ctx: AbilityCtx): number {
    const sightings = ctx.world.cameraSightings();
    if (sightings.length === 0) return 0;
    // Trust the most confident report. Confidence is the camera's, not truth.
    const best = sightings.reduce((a, b) => (b.confidence > a.confidence ? b : a));

    ctx.world.emitFx({
      kind: "link",
      x: ctx.mimic.x,
      y: ctx.mimic.y,
      toX: best.x,
      toY: best.y,
      radius: TILE,
      life: 1,
    });
    ctx.world.play("link", 0.35);
    ctx.mimic.investigateAt(best.x, best.y);
    return 0;
  }
}

/* ------------------------------------------------------------ POWER SURGE */

/**
 * Brown out a zone. Harder to navigate — and the zone's own cameras go with it,
 * so MIMIC blinds itself in the same breath. A pure downside would be a tax; a
 * trade is a decision.
 */
class PowerSurge implements Ability {
  readonly id: AbilityId = "power_surge";
  private zone: string | null = null;

  ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.unseenT < 2.5) return false;
    const last = ctx.mimic.lastKnown;
    this.zone = last
      ? ctx.world.level.zoneIdAt(Math.floor(last.x / TILE), Math.floor(last.y / TILE))
      : // With no lead at all, brown out the zone this player uses most. That is
        // learned route data, not live knowledge — it is allowed to be wrong.
        (ctx.strategy.patrolZones[0] ?? null);
    return this.zone !== null;
  }

  activate(ctx: AbilityCtx): number {
    if (!this.zone) return 0;
    ctx.world.surgeZone(this.zone, 8);
    ctx.world.emitFx({ kind: "surge", x: ctx.mimic.x, y: ctx.mimic.y, radius: TILE * 9, life: 1.1 });
    ctx.world.play("surge", 0.5);
    return 0;
  }
}

/* -------------------------------------------------------------- DEEP SCAN */

/**
 * A wide local sweep for *disturbances* — footfalls, interactions, ECHO
 * activity. It returns a sector, never a position, and it cannot distinguish
 * you from a copy. Standing still leaves nothing to find.
 */
class DeepScan implements Ability {
  readonly id: AbilityId = "deep_scan";

  ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.holdT > 0) return false;
    // Sweeping for disturbances is just as sensible on patrol as mid-search —
    // and it still finds nothing unless the player has actually made noise.
    if (ctx.mimic.state === "chase" || ctx.mimic.state === "alert") return false;
    return ctx.mimic.unseenT > 3.5;
  }

  activate(ctx: AbilityCtx): number {
    ctx.mimic.holdT = 2.6;
    ctx.world.emitFx({
      kind: "deep",
      x: ctx.mimic.x,
      y: ctx.mimic.y,
      radius: TILE * 12,
      life: 2.6,
    });
    ctx.world.play("scan", 0.7);
    return 2.6;
  }

  update(ctx: AbilityCtx): void {
    ctx.mimic.holdT = Math.max(ctx.mimic.holdT, 0.05);
  }

  end(ctx: AbilityCtx): void {
    const found = ctx.world.disturbancesNear(ctx.mimic.x, ctx.mimic.y, TILE * 12);
    if (found.length === 0) return;
    // Deliberately coarse: a sector to go and look at, not a target.
    const sector = sectorCentre(found[0].x, found[0].y);
    ctx.mimic.investigateAt(sector.x, sector.y);
    ctx.world.log("DISTURBANCE LOCALISED");
  }
}

/* ------------------------------------------------------ FACILITY OVERRIDE */

const SUBSYSTEMS = ["DOORS", "CAMERAS", "LIGHTS"] as const;

/**
 * Signature move: bind to one subsystem for a while. Powerful, and openly
 * exploitable — MIMIC is slowed and half-blind for the whole connection, so
 * provoking it is a legitimate way to buy yourself a window.
 */
class FacilityOverride implements Ability {
  readonly id: AbilityId = "facility_override";
  private mode: (typeof SUBSYSTEMS)[number] = "DOORS";

  ready(ctx: AbilityCtx): boolean {
    if (ctx.mimic.state === "patrol") return false;
    return ctx.playerConfirmed || ctx.mimic.unseenT < 3;
  }

  activate(ctx: AbilityCtx): number {
    this.mode = SUBSYSTEMS[ctx.rng.int(0, SUBSYSTEMS.length)];
    const duration = 9;

    // The tradeoff, applied up front so it is never forgotten.
    ctx.mimic.distracted = 0.6;

    if (this.mode === "DOORS") {
      for (const id of ctx.world.lockableDoors().slice(0, 2)) {
        ctx.world.lockDoor(id, duration);
      }
    } else if (this.mode === "LIGHTS") {
      const zone = ctx.player.zone ?? ctx.world.level.zones[0]?.id;
      if (zone) ctx.world.surgeZone(zone, duration);
    }
    // CAMERAS: the link is already live for the duration; nothing to seize.

    ctx.world.emitFx({
      kind: "override",
      x: ctx.mimic.x,
      y: ctx.mimic.y,
      radius: TILE * 14,
      life: 1.6,
    });
    ctx.world.play("override", 0.7);
    ctx.world.notice("FACILITY OVERRIDE");
    ctx.world.log(`SUBSYSTEM LINK // ${this.mode}`);
    return duration;
  }

  update(ctx: AbilityCtx): void {
    ctx.mimic.distracted = 0.6;
  }

  end(ctx: AbilityCtx): void {
    ctx.mimic.distracted = 0;
  }
}

/** Builds the full ability set. The book is shared with the passives. */
export function createAbilities(book: AnalysisBook): Map<AbilityId, Ability> {
  const list: Ability[] = [
    new FocusScan(),
    new SoundAnalysis(book),
    new EchoAnalysis(book),
    new RoutePrediction(),
    new Intercept(),
    new DoorControl(),
    new CameraLink(),
    new PowerSurge(),
    new DeepScan(),
    new FacilityOverride(),
  ];
  return new Map(list.map((a) => [a.id, a]));
}
