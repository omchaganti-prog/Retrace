/**
 * What Subject 047 knows.
 *
 * RETRACE's three kinds of state are deliberately separate, and the separation
 * is the story:
 *
 *   TimelineState   doors, switches, puzzle timers   — RETRACE wipes it
 *   PlayerKnowledge what you have discovered          — survives everything
 *   MimicMemory     what it has learned about you     — survives everything
 *
 * This file is the middle one. Discovering the archives is not something the
 * facility can take back by resetting the timeline, so a reveal never replays
 * and a terminal never un-reads itself. The player forgets nothing.
 *
 * MIMIC's memory is the same shape, which is the quiet joke: the only thing the
 * facility can reset is the room.
 */

export type StoryFlag =
  /* --- chapter one: the test ------------------------------------------- */
  | "openingSeen"
  | "firstRetrace"
  | "firstEchoCreated"
  | "firstMimicSighting"
  /* --- chapter two: observation ---------------------------------------- */
  | "firstDetection"
  | "firstMimicAdaptation"
  | "trialGlitchSeen"
  | "behaviourProfileRead"
  /* --- chapter three: something is wrong -------------------------------- */
  | "firstCollapse"
  | "residueNoticed"
  | "oldEchoSeen"
  /* --- chapter four: the archives --------------------------------------- */
  | "archivesFound"
  | "restorationCountRead"
  | "memoryResetRevealed"
  | "mimicPurposeRevealed"
  /* --- chapter five: containment ---------------------------------------- */
  | "containmentTruthRevealed"
  | "surfaceAccessUnlocked"
  | "finalHuntBegun"
  | "mimicPredictionFailed"
  | "escaped";

/** Chapters exist to pace reveals; they never gate gameplay. */
export const CHAPTERS = [
  { id: "test", title: "THE TEST" },
  { id: "observation", title: "OBSERVATION" },
  { id: "wrong", title: "SOMETHING IS WRONG" },
  { id: "archives", title: "THE ARCHIVES" },
  { id: "containment", title: "CONTAINMENT" },
] as const;

export type ChapterId = (typeof CHAPTERS)[number]["id"];

export class StoryFlags {
  private readonly set = new Set<StoryFlag>();
  /** Counters the behaviour terminals read from. */
  private readonly counts = new Map<string, number>();

  has(flag: StoryFlag): boolean {
    return this.set.has(flag);
  }

  /** Raises a flag. Returns true only the first time — reveals never repeat. */
  raise(flag: StoryFlag): boolean {
    if (this.set.has(flag)) return false;
    this.set.add(flag);
    return true;
  }

  clear(flag: StoryFlag): void {
    this.set.delete(flag);
  }

  all(): StoryFlag[] {
    return [...this.set].sort();
  }

  bump(key: string, by = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Developer tool only. */
  resetAll(): void {
    this.set.clear();
    this.counts.clear();
  }
}
