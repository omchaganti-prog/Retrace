/**
 * The terminals that read the player.
 *
 * Everything printed here comes from the save the game has actually been
 * keeping — MIMIC's route counters, its hiding-spot tallies, the adaptation
 * meters, the real catch and collapse totals. Nothing is invented for flavour.
 *
 * That is the entire point of these screens. A dossier that guessed would be
 * set dressing; one that names the corridor you genuinely favour is the moment
 * the player realises the game has been taking notes since the first minute.
 */
import type { Adaptation } from "../ai/adaptation";
import type { MimicMemory } from "../systems/memory";
import type { Level } from "../world/level";

export interface DossierSource {
  memory: MimicMemory;
  adaptation: Adaptation;
  level: Level;
  run: number;
  /** Real restorations: collapses recorded, offset by the trials before you. */
  collapses: number;
}

/** Trials the facility ran before this one. The number is never explained. */
export const PRIOR_RESTORATIONS = 826;

const band = (v: number, low: number, high: number): string =>
  v >= high ? "HIGH" : v >= low ? "MODERATE" : "LOW";

const pad = (label: string, value: string): string => `${label.padEnd(22)}${value}`;

/**
 * The behaviour profile.
 *
 * Reads MIMIC's own counters, so the corridor it names is the corridor the
 * player has genuinely walked most — and the confidence figure is the same
 * knowledge score that gates what MIMIC is allowed to say out loud.
 */
export function behaviourLines(src: DossierSource): string[] {
  const d = src.memory.data;
  const routes = src.memory.rankedRoutes();
  const hides = src.memory.rankedHides();
  const a = src.adaptation.values;

  const topRoute = routes[0];
  const routeName = topRoute ? src.level.zoneLabel(topRoute.id) : "INSUFFICIENT DATA";
  const hideName = hides[0]
    ? hides[0].id.replace(/^hide_/, "").replace(/_/g, " ").toUpperCase()
    : "NONE OBSERVED";

  const lines = [
    pad("PRIMARY ROUTE:", routeName),
    pad("ROUTE SAMPLES:", String(topRoute?.count ?? 0)),
    "",
    pad("TEMPORAL DECOY USE:", band(a.echoDependency, 12, 40)),
    pad("ACOUSTIC SIGNATURE:", band(a.noiseDependency, 12, 40)),
    pad("CONCEALMENT:", band(a.hidingRepetition, 12, 40)),
    pad("EGRESS RELIANCE:", band(a.doorDependency, 12, 40)),
    pad("RECURSION RELIANCE:", band(a.retraceDependency, 12, 40)),
    "",
    pad("PREFERRED CONCEALMENT:", hideName),
    pad("CONTAINMENT EVENTS:", String(d.catches)),
    "",
    pad("PREDICTION CONFIDENCE:", `${src.memory.knowledge()}%`),
  ];

  // Before it has seen anything, the facility says so rather than guessing.
  if (routes.length === 0) {
    return [
      pad("PRIMARY ROUTE:", "INSUFFICIENT DATA"),
      "",
      "SUBJECT HAS NOT YET ESTABLISHED",
      "A REPEATABLE PATTERN.",
      "",
      pad("PREDICTION CONFIDENCE:", `${src.memory.knowledge()}%`),
    ];
  }
  return lines;
}

/**
 * The trial list, and the thing hiding underneath it.
 *
 * The visible list is unremarkable: six completed trials and this one, active.
 * The corrupted variant is what the glitch shows for a third of a second.
 */
export function trialLines(src: DossierSource, glitched: boolean): string[] {
  const header = ["TRIAL RECORDS", ""];
  if (!glitched) {
    return [
      ...header,
      "041 — COMPLETE",
      "042 — COMPLETE",
      "043 — COMPLETE",
      "044 — COMPLETE",
      "045 — COMPLETE",
      "046 — COMPLETE",
      "047 — ACTIVE",
    ];
  }
  // Trials that have not happened yet, listed as already finished.
  return [
    ...header,
    "047 — COMPLETE",
    "048 — COMPLETE",
    "049 — COMPLETE",
    "050 — COMPLETE",
    "051 — COMPLETE",
    "052 — COMPLETE",
    `${(PRIOR_RESTORATIONS + src.collapses).toString().padStart(3, "0")} — ACTIVE`,
  ];
}

/**
 * The archives number.
 *
 * Counts the player's own collapses on top of the facility's prior total, so
 * the figure is partly theirs — every timeline they have personally lost is in
 * it. It is printed and then left alone.
 */
export function restorationLines(src: DossierSource): string[] {
  const total = PRIOR_RESTORATIONS + src.collapses;
  return [
    pad("SUBJECT:", "047"),
    "",
    pad("MEMORY RESTORATION:", "FAILED"),
    pad("MEMORY SUPPRESSION:", "SUCCESSFUL"),
    "",
    "BASELINE RESTORATIONS:",
    "",
    `        ${total}`,
  ];
}
