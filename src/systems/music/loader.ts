/**
 * Stem loading.
 *
 * Fetches each stem from `public/audio/music/` and decodes it. If a file is
 * missing or unreadable the stem is replaced by a silent buffer of exactly the
 * right length rather than being dropped — a missing file must never change the
 * loop length, because that is what would let the stems drift apart.
 *
 * This is the whole replacement story: overwrite a `.wav` and the loader picks
 * it up. Nothing else in the codebase names an audio file.
 */
import { LOOP_SECONDS, type StemId, STEMS, stemUrl } from "./manifest";

export interface LoadedStems {
  buffers: Map<StemId, AudioBuffer>;
  /** Stems that fell back to silence, for diagnostics. */
  missing: StemId[];
  /** Stems whose length disagreed with the manifest. */
  mismatched: { id: StemId; seconds: number }[];
}

/** How far a file's length may differ from the manifest before we complain. */
const LENGTH_TOLERANCE = 0.02;

function silentBuffer(ctx: BaseAudioContext): AudioBuffer {
  return ctx.createBuffer(1, Math.round(LOOP_SECONDS * ctx.sampleRate), ctx.sampleRate);
}

async function fetchStem(ctx: BaseAudioContext, url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    return await ctx.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

/**
 * Loads every stem in parallel. Always resolves with a buffer for each stem so
 * the manager can assume a complete, equal-length set.
 */
export async function loadStems(ctx: BaseAudioContext, base = ""): Promise<LoadedStems> {
  const out: LoadedStems = { buffers: new Map(), missing: [], mismatched: [] };

  await Promise.all(
    STEMS.map(async (spec) => {
      const decoded = await fetchStem(ctx, `${base}${stemUrl(spec)}`);
      if (!decoded) {
        out.missing.push(spec.id);
        out.buffers.set(spec.id, silentBuffer(ctx));
        return;
      }
      if (Math.abs(decoded.duration - LOOP_SECONDS) > LENGTH_TOLERANCE) {
        // Kept and played anyway — but flagged loudly, because a stem of the
        // wrong length is the one thing that breaks synchronisation.
        out.mismatched.push({ id: spec.id, seconds: decoded.duration });
      }
      out.buffers.set(spec.id, decoded);
    }),
  );

  return out;
}
