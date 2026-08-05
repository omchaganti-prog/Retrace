/**
 * Pattern recognition — the part of MIMIC that gets tired of your tricks.
 *
 * Both the sound and ECHO analyses work the same way: reduce an event to a
 * coarse *signature*, count how often that signature repeats, and lower
 * confidence as it does. Crucially this is confidence, not identification —
 * MIMIC never gets told "that was an ECHO". It gets less interested in a noise
 * it has heard in the same place a dozen times, which is a very different thing
 * and leaves the door open for a genuinely new pattern to work perfectly.
 *
 * Pure module: no DOM, so it is unit-testable under Node.
 */
import { TILE } from "../core/constants";

/** Signatures are quantised to this many tiles, so "the same trick" is fuzzy. */
const SIGNATURE_TILES = 4;
/** Repeats needed before confidence bottoms out. */
const FAMILIARITY_CAP = 5;
/** Confidence never drops below this — a stale lure is still worth a glance. */
const MIN_CONFIDENCE = 0.25;

const cell = (v: number): number => Math.floor(v / (TILE * SIGNATURE_TILES));

export function signatureAt(x: number, y: number, kind: string): string {
  return `${kind}@${cell(x)},${cell(y)}`;
}

export interface PatternEntry {
  count: number;
  /** Run index this was last observed on, so repeats across runs still count. */
  lastRun: number;
}

/**
 * Familiarity ledger. Survives RETRACE (it lives on the Game, not the run) so a
 * decoy you reuse every attempt genuinely wears out.
 */
export class AnalysisBook {
  private readonly sounds = new Map<string, PatternEntry>();
  private readonly echoes = new Map<string, PatternEntry>();

  /** True once the corresponding ability has developed. */
  soundAnalysisActive = false;
  echoAnalysisActive = false;

  noteSound(x: number, y: number, kind: string, run: number): string {
    const sig = signatureAt(x, y, kind);
    const e = this.sounds.get(sig);
    // Only one credit per run per signature: standing still spamming footsteps
    // in one spot should not instantly exhaust the pattern.
    if (!e) this.sounds.set(sig, { count: 1, lastRun: run });
    else if (e.lastRun !== run) {
      e.count++;
      e.lastRun = run;
    }
    return sig;
  }

  noteEchoPattern(echoId: string, x: number, y: number, kind: string, run: number): string {
    const sig = `${echoId}:${signatureAt(x, y, kind)}`;
    const e = this.echoes.get(sig);
    if (!e) this.echoes.set(sig, { count: 1, lastRun: run });
    else if (e.lastRun !== run) {
      e.count++;
      e.lastRun = run;
    }
    return sig;
  }

  /**
   * 0..1 — how much MIMIC still believes this noise is worth chasing. A brand
   * new pattern is fully interesting; one it has heard five runs running is not.
   */
  soundConfidence(x: number, y: number, kind: string): number {
    if (!this.soundAnalysisActive) return 1;
    const e = this.sounds.get(signatureAt(x, y, kind));
    if (!e) return 1;
    return this.fade(e.count);
  }

  echoConfidence(echoId: string, x: number, y: number, kind: string): number {
    if (!this.echoAnalysisActive) return 1;
    const e = this.echoes.get(`${echoId}:${signatureAt(x, y, kind)}`);
    if (!e) return 1;
    return this.fade(e.count);
  }

  /** How well-worn the most repeated pattern is, 0..1. For the debug overlay. */
  familiarity(): number {
    let top = 0;
    for (const e of this.sounds.values()) top = Math.max(top, e.count);
    for (const e of this.echoes.values()) top = Math.max(top, e.count);
    return Math.min(1, top / FAMILIARITY_CAP);
  }

  size(): { sounds: number; echoes: number } {
    return { sounds: this.sounds.size, echoes: this.echoes.size };
  }

  private fade(count: number): number {
    const wear = Math.min(1, (count - 1) / FAMILIARITY_CAP);
    return Math.max(MIN_CONFIDENCE, 1 - wear * (1 - MIN_CONFIDENCE));
  }
}
