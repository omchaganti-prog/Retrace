/**
 * Movement stamina — one pool shared by sprint and the charged dash.
 *
 * The rules that matter: it only drains when actually spent, the dash is
 * refused rather than half-committed when you cannot afford it, a charge is
 * aimed by facing, and it all comes back.
 */
import { describe, expect, it } from "vitest";
import { DASH, PLAYER, STAMINA, TICK_DT } from "../src/core/constants";
import type { InputSnapshot } from "../src/core/input";
import { Player } from "../src/entities/player";
import { tileCenter } from "../src/world/level";
import { testLevel } from "./helpers";

const IDLE: InputSnapshot = {
  up: false,
  down: false,
  left: false,
  right: false,
  sprint: false,
  sneak: false,
  dash: false,
};
const RUN_RIGHT: InputSnapshot = { ...IDLE, right: true, sprint: true };
const WALK_RIGHT: InputSnapshot = { ...IDLE, right: true };
const CHARGE: InputSnapshot = { ...IDLE, dash: true };
const CHARGE_RIGHT: InputSnapshot = { ...IDLE, right: true, dash: true };

const START = tileCenter(2, 3);

function freshPlayer(): Player {
  const p = new Player();
  p.reset(START.x, START.y);
  return p;
}

/** Runs `seconds` of simulation, re-centring so the corridor never runs out. */
function hold(p: Player, input: InputSnapshot, seconds: number): void {
  const level = testLevel();
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    p.update(TICK_DT, level, input);
    p.x = START.x;
    p.y = START.y;
  }
}

/** Runs without re-centring, so travel can be measured. */
function free(p: Player, input: InputSnapshot, seconds: number): void {
  const level = testLevel();
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    p.update(TICK_DT, level, input);
  }
}

/** Sprints until the pool empties, stopping on that exact tick. */
function drain(p: Player): void {
  const level = testLevel();
  for (let i = 0; i < 6000 && !p.exhausted; i++) {
    p.update(TICK_DT, level, RUN_RIGHT);
    p.x = START.x;
    p.y = START.y;
  }
  expect(p.exhausted).toBe(true);
}

describe("the shared pool", () => {
  it("starts full and idles without draining", () => {
    const p = freshPlayer();
    expect(p.stamina).toBe(STAMINA.max);
    expect(p.staminaFraction).toBe(1);
    hold(p, IDLE, 2);
    expect(p.stamina).toBe(STAMINA.max);
  });

  it("does not drain while walking", () => {
    const p = freshPlayer();
    hold(p, WALK_RIGHT, 2);
    expect(p.stamina).toBe(STAMINA.max);
    expect(p.sprinting).toBe(false);
  });

  it("drains only while the sprint actually moves you", () => {
    const p = freshPlayer();
    hold(p, { ...IDLE, sprint: true }, 2);
    expect(p.stamina).toBe(STAMINA.max);

    hold(p, RUN_RIGHT, 1);
    expect(p.sprinting).toBe(true);
    expect(p.stamina).toBeLessThan(STAMINA.max);
  });

  it("empties after roughly the configured sprint duration", () => {
    const p = freshPlayer();
    const expected = STAMINA.max / STAMINA.sprintDrain;
    hold(p, RUN_RIGHT, expected - 0.3);
    expect(p.exhausted).toBe(false);
    hold(p, RUN_RIGHT, 0.5);
    expect(p.stamina).toBe(0);
    expect(p.exhausted).toBe(true);
  });

  it("recharges after the delay and unlocks part-way back", () => {
    const p = freshPlayer();
    drain(p);

    hold(p, IDLE, STAMINA.regenDelay * 0.5);
    expect(p.stamina).toBe(0);

    hold(p, IDLE, STAMINA.regenDelay + STAMINA.unlockAt / STAMINA.regenRate + 0.1);
    expect(p.exhausted).toBe(false);
    expect(p.stamina).toBeGreaterThanOrEqual(STAMINA.unlockAt);
    expect(p.stamina).toBeLessThan(STAMINA.max);

    hold(p, IDLE, STAMINA.max / STAMINA.regenRate);
    expect(p.stamina).toBe(STAMINA.max);
  });

  it("cannot be stutter-sprinted off an empty meter", () => {
    const p = freshPlayer();
    drain(p);
    const level = testLevel();
    for (let i = 0; i < 60; i++) {
      p.update(TICK_DT, level, i % 2 === 0 ? RUN_RIGHT : WALK_RIGHT);
      p.x = START.x;
      p.y = START.y;
      expect(p.sprinting).toBe(false);
    }
  });

  it("does not stutter back on while the sprint key stays held", () => {
    const p = freshPlayer();
    drain(p);
    const level = testLevel();
    // Long enough to climb well past the unlock threshold and back down again.
    for (let i = 0; i < 60 * 8; i++) {
      p.update(TICK_DT, level, RUN_RIGHT);
      p.x = START.x;
      p.y = START.y;
      expect(p.sprinting).toBe(false);
    }
    // It recovered — it simply refused to spend it without a fresh press.
    expect(p.stamina).toBe(STAMINA.max);
  });

  it("sprints again once the key is released and re-pressed", () => {
    const p = freshPlayer();
    drain(p);
    hold(p, WALK_RIGHT, STAMINA.regenDelay + STAMINA.max / STAMINA.regenRate + 0.1);
    hold(p, RUN_RIGHT, 0.2);
    expect(p.sprinting).toBe(true);
  });

  it("restores a full pool on a new run", () => {
    const p = freshPlayer();
    drain(p);
    p.reset(START.x, START.y);
    expect(p.stamina).toBe(STAMINA.max);
    expect(p.exhausted).toBe(false);
    expect(p.charge).toBe(0);
  });
});

describe("charging the dash", () => {
  it("builds while held and slows you down", () => {
    const p = freshPlayer();
    hold(p, CHARGE_RIGHT, 0.3);
    expect(p.charging).toBe(true);
    expect(p.charge).toBeGreaterThan(0);
    expect(p.charge).toBeLessThan(1);
    // The wind-up is a commitment: you move at a fraction of walking speed.
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(PLAYER.walkSpeed * 0.6);
  });

  it("caps at full charge", () => {
    const p = freshPlayer();
    hold(p, CHARGE, DASH.chargeSeconds + 0.5);
    expect(p.charge).toBe(1);
  });

  it("costs the whole bar at full charge, and only a full bar can reach it", () => {
    const p = freshPlayer();
    hold(p, CHARGE, DASH.chargeSeconds + 0.5);
    expect(p.charge).toBe(1);
    expect(p.chargeCost).toBe(STAMINA.max);

    // One unit short of full and the maximum is already out of reach.
    const nearly = freshPlayer();
    nearly.stamina = STAMINA.max - 1;
    hold(nearly, CHARGE, DASH.chargeSeconds + 0.5);
    expect(nearly.charge).toBeLessThan(1);
  });

  it("caps at what the pool can actually pay for", () => {
    const p = freshPlayer();
    // Half way between the cheapest and the dearest dash.
    p.stamina = (DASH.costMin + DASH.costMax) / 2;
    hold(p, CHARGE, DASH.chargeSeconds + 0.5);

    expect(p.charge).toBeCloseTo(0.5, 2);
    expect(p.charge).toBeLessThan(1);
    // The wind-up promises exactly the dash you can buy — no more.
    expect(p.chargeCost).toBeLessThanOrEqual(p.stamina + 1e-6);
    expect(p.chargeDistance).toBeLessThan(DASH.distanceMax);
  });

  it("spends the capped charge instead of refusing it", () => {
    const p = freshPlayer();
    p.stamina = (DASH.costMin + DASH.costMax) / 2;
    hold(p, CHARGE, DASH.chargeSeconds + 0.5);

    const level = testLevel();
    const step = p.update(TICK_DT, level, IDLE);

    expect(step.dashed).toBe(true);
    expect(step.dashFailed).toBe(false);
    expect(p.stamina).toBeCloseTo(0, 5);
  });

  it("refuses rather than capping below the launch floor", () => {
    const p = freshPlayer();
    // Enough for the cheapest dash on paper, but not enough to clear the floor
    // where a charge actually fires — this must be a refusal, not a silent nub.
    p.stamina = DASH.costMin + 0.1;
    const level = testLevel();
    const step = p.update(TICK_DT, level, CHARGE);

    expect(step.dashFailed).toBe(true);
    expect(p.charging).toBe(false);
  });

  it("always launches whatever it let you charge", () => {
    const level = testLevel();
    // Sweep the whole affordable range: any charge that builds must also fire.
    for (let s = DASH.costMin; s <= STAMINA.max; s += 0.5) {
      const p = freshPlayer();
      p.stamina = s;
      hold(p, CHARGE, DASH.chargeSeconds + 0.3);
      if (!p.charging) continue; // refused up front — the honest answer

      const step = p.update(TICK_DT, level, IDLE);
      expect(step.dashed).toBe(true);
      expect(p.stamina).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("costs more and travels further the longer it is held", () => {
    const light = freshPlayer();
    hold(light, CHARGE, DASH.chargeSeconds * 0.25);
    const lightCost = light.chargeCost;
    const lightDist = light.chargeDistance;

    const heavy = freshPlayer();
    hold(heavy, CHARGE, DASH.chargeSeconds + 0.2);

    expect(heavy.chargeCost).toBeGreaterThan(lightCost);
    expect(heavy.chargeDistance).toBeGreaterThan(lightDist);
    expect(heavy.chargeCost).toBeCloseTo(DASH.costMax, 5);
  });
});

describe("releasing the dash", () => {
  it("spends stamina and launches", () => {
    const p = freshPlayer();
    hold(p, CHARGE, DASH.chargeSeconds + 0.2);
    const before = p.stamina;

    const level = testLevel();
    const step = p.update(TICK_DT, level, IDLE);

    expect(step.dashed).toBe(true);
    expect(p.dashing).toBe(true);
    expect(before - p.stamina).toBeCloseTo(DASH.costMax, 1);
  });

  it("travels along the facing, not the input", () => {
    const p = freshPlayer();
    // Face west, then release with no direction held.
    free(p, { ...IDLE, left: true }, 0.2);
    const facing = p.dir;
    p.x = START.x;
    p.y = START.y;

    hold(p, CHARGE, DASH.chargeSeconds + 0.2);
    const x0 = p.x;
    free(p, IDLE, DASH.duration + 0.05);

    expect(p.dir).toBe(facing);
    // Went west, the way it was pointed.
    expect(p.x).toBeLessThan(x0);
  });

  it("covers roughly the charged distance", () => {
    const p = freshPlayer();
    free(p, { ...IDLE, right: true }, 0.2);
    p.x = START.x;
    p.y = START.y;
    hold(p, CHARGE, DASH.chargeSeconds + 0.2);

    const x0 = p.x;
    free(p, IDLE, DASH.duration);
    const travelled = Math.abs(p.x - x0);

    expect(travelled).toBeGreaterThan(DASH.distanceMax * 0.6);
  });

  it("refunds a mis-tap too short to matter", () => {
    const p = freshPlayer();
    const level = testLevel();
    p.update(TICK_DT, level, CHARGE);
    const step = p.update(TICK_DT, level, IDLE);

    expect(step.dashed).toBe(false);
    expect(step.dashFailed).toBe(false);
    expect(p.stamina).toBe(STAMINA.max);
  });

  it("is refused outright when the pool is too low", () => {
    const p = freshPlayer();
    drain(p);
    const level = testLevel();

    const step = p.update(TICK_DT, level, CHARGE);

    // Refused up front rather than charging with nothing to spend.
    expect(step.dashFailed).toBe(true);
    expect(p.charging).toBe(false);
    expect(p.charge).toBe(0);
    expect(p.dashing).toBe(false);
  });

  it("reports the refusal once per press, not every tick", () => {
    const p = freshPlayer();
    drain(p);
    const level = testLevel();

    let refusals = 0;
    for (let i = 0; i < 60; i++) {
      if (p.update(TICK_DT, level, CHARGE).dashFailed) refusals++;
      p.x = START.x;
      p.y = START.y;
    }
    expect(refusals).toBe(1);

    // Releasing and pressing again is a new refusal.
    p.update(TICK_DT, level, IDLE);
    expect(p.update(TICK_DT, level, CHARGE).dashFailed).toBe(true);
  });

  it("cannot be chained instantly", () => {
    const p = freshPlayer();
    hold(p, CHARGE, DASH.chargeSeconds + 0.2);
    free(p, IDLE, TICK_DT);
    expect(p.dashing).toBe(true);

    // Holding again during the burst and recovery must not start a second one.
    free(p, CHARGE, DASH.duration + DASH.recovery * 0.5);
    expect(p.charge).toBe(0);
  });

  it("never ends inside a wall, from anywhere, in any direction", () => {
    // A full-charge burst crosses six tiles, so every launch point in the test
    // map is within range of a wall. None of them may end up behind one.
    const level = testLevel();
    const AIM: Array<Partial<InputSnapshot>> = [
      { right: true },
      { right: true, down: true },
      { down: true },
      { left: true, down: true },
      { left: true },
      { left: true, up: true },
      { up: true },
      { right: true, up: true },
    ];

    for (let tx = 1; tx <= 7; tx++) {
      for (let ty = 1; ty <= 3; ty++) {
        if (level.blocksMove(tx, ty)) continue;
        for (const aim of AIM) {
          const p = new Player();
          const at = tileCenter(tx, ty);
          p.reset(at.x, at.y);

          // Face the aim, pinned in place, then charge fully and let it fly.
          for (let i = 0; i < 4; i++) {
            p.update(TICK_DT, level, { ...IDLE, ...aim });
            p.x = at.x;
            p.y = at.y;
          }
          for (let i = 0; i < Math.round((DASH.chargeSeconds + 0.2) / TICK_DT); i++) {
            p.update(TICK_DT, level, CHARGE);
            p.x = at.x;
            p.y = at.y;
          }
          free(p, IDLE, DASH.duration + 0.1);

          const inWall = level.blocksMove(Math.floor(p.x / 16), Math.floor(p.y / 16));
          expect(
            inWall,
            `dash from ${tx},${ty} aimed ${JSON.stringify(aim)} ended in a wall`,
          ).toBe(false);
        }
      }
    }
  });

  it("stops dead against a wall instead of tunnelling", () => {
    const p = freshPlayer();
    const level = testLevel();
    // Face west and dash into the left wall of the corridor.
    free(p, { ...IDLE, left: true }, 0.3);
    hold(p, CHARGE, DASH.chargeSeconds + 0.2);
    free(p, IDLE, DASH.duration + 0.1);

    const tx = Math.floor(p.x / 16);
    const ty = Math.floor(p.y / 16);
    expect(level.blocksMove(tx, ty)).toBe(false);
  });
});

describe("sprint and dash share one budget", () => {
  it("a dash leaves less sprint available", () => {
    const full = freshPlayer();
    hold(full, RUN_RIGHT, 1);
    const spentBySprintAlone = STAMINA.max - full.stamina;

    const dashed = freshPlayer();
    hold(dashed, CHARGE, DASH.chargeSeconds + 0.2);
    free(dashed, IDLE, TICK_DT);
    const afterDash = dashed.stamina;
    hold(dashed, RUN_RIGHT, 1);

    expect(afterDash).toBeLessThan(STAMINA.max);
    expect(STAMINA.max - dashed.stamina).toBeGreaterThan(spentBySprintAlone);
  });

  it("costs more to spend than it earns back", () => {
    // The tension only exists if movement is not free to repeat.
    const drainTime = STAMINA.max / STAMINA.sprintDrain;
    const refillTime = STAMINA.max / STAMINA.regenRate;
    expect(refillTime).toBeGreaterThan(drainTime);
  });
});
