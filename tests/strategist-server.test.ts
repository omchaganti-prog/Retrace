/**
 * Provider selection for the Node-side strategist.
 *
 * Only the pure routing logic is exercised — no network. Which vendor answers is
 * invisible to the game, so a silent mis-route would otherwise surface as
 * "MIMIC LINK stuck on LOCAL" with nothing to point at.
 */
import { describe, expect, it } from "vitest";
import { activeProvider, planStrategy } from "../server/mimic-strategist.mjs";

const ANTHROPIC = { ANTHROPIC_API_KEY: "sk-ant-placeholder" };
const OPENAI = { OPENAI_API_KEY: "sk-proj-placeholder" };

describe("provider selection", () => {
  it("uses whichever single key is present", () => {
    expect(activeProvider(ANTHROPIC)).toBe("anthropic");
    expect(activeProvider(OPENAI)).toBe("openai");
  });

  it("prefers Anthropic when both keys are set", () => {
    expect(activeProvider({ ...ANTHROPIC, ...OPENAI })).toBe("anthropic");
  });

  it("honours the MIMIC_PROVIDER override in both directions", () => {
    expect(activeProvider({ ...ANTHROPIC, ...OPENAI, MIMIC_PROVIDER: "openai" })).toBe("openai");
    expect(activeProvider({ ...ANTHROPIC, ...OPENAI, MIMIC_PROVIDER: "anthropic" })).toBe(
      "anthropic",
    );
  });

  it("does not silently substitute the other provider when one is forced", () => {
    // Asking for Anthropic and getting OpenAI would be a confusing surprise —
    // better to fall back to the local model.
    expect(activeProvider({ ...OPENAI, MIMIC_PROVIDER: "anthropic" })).toBeNull();
  });

  it("treats a blank or whitespace-only key as absent", () => {
    expect(activeProvider({ OPENAI_API_KEY: "   " })).toBeNull();
    expect(activeProvider({ ANTHROPIC_API_KEY: "" })).toBeNull();
  });

  it("reports no provider at all when the environment is bare", () => {
    expect(activeProvider({})).toBeNull();
  });
});

describe("keyless behaviour", () => {
  it("answers without touching the network so the game can fall back", async () => {
    await expect(planStrategy({ zones: [], hideSpots: [] }, {})).resolves.toEqual({
      ok: false,
      reason: "no_api_key",
    });
  });
});
