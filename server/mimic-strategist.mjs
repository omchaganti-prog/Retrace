/**
 * Server-side MIMIC strategist.
 *
 * Runs in Node (Vite dev middleware or the standalone server), never in the
 * browser — the API key stays on this side of the wire. The browser POSTs
 * MIMIC's accumulated behaviour stats to /api/mimic/strategy and gets back a
 * small, strictly-shaped strategy object that biases the AI's next run.
 *
 * Provider-agnostic on purpose: the browser treats the strategist as an opaque
 * upgrade, so the only thing that has to know which vendor answered is this
 * file. Whichever key is present gets used — Anthropic wins if both are set,
 * and MIMIC_PROVIDER forces one either way. Both providers are driven through
 * the same JSON schema and the same prompt, so the game cannot tell them apart
 * beyond the `source` label it shows in the HUD.
 *
 * The game is fully playable without any of this: src/systems/strategist.ts
 * falls back to a deterministic local model whenever the endpoint is missing,
 * keyless, slow, or wrong. Treat everything here as an optional upgrade.
 */

const ANTHROPIC_MODEL = "claude-opus-5";
const OPENAI_MODEL_DEFAULT = "gpt-4o-mini";

/**
 * Generous because Claude Opus 5 thinks by default and `max_tokens` caps
 * thinking *and* response text together — a tight budget truncates the strategy
 * object mid-JSON. It is a ceiling, not a spend: the answer is a few hundred
 * tokens either way.
 */
const MAX_TOKENS = 4096;

/** Hard ceiling so a slow call can never stall the run-start handoff. */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Structured-output schema, shared by both providers.
 *
 * Note the deliberate omissions: neither the Anthropic JSON-schema subset nor
 * OpenAI's strict mode supports numeric bounds (minimum/maximum) or string
 * length limits, so every value is re-validated and clamped below. OpenAI's
 * strict mode additionally requires `additionalProperties: false` and every
 * property listed in `required` — which this schema already satisfies.
 */
const STRATEGY_SCHEMA = {
  type: "object",
  properties: {
    patrolZones: {
      type: "array",
      description:
        "Zone ids MIMIC should patrol next run, most important first. 3 to 6 entries, drawn only from the supplied zone vocabulary.",
      items: { type: "string" },
    },
    guardZone: {
      type: "array",
      description:
        "Zero or one zone id MIMIC should camp near, if one objective is clearly next. Empty array means do not camp.",
      items: { type: "string" },
    },
    searchSpots: {
      type: "array",
      description:
        "Hiding-spot ids to sweep during a search, most likely first. 0 to 4 entries from the supplied hide-spot vocabulary.",
      items: { type: "string" },
    },
    echoSkepticism: {
      type: "number",
      description:
        "0 to 1. How much MIMIC discounts noise made by ECHOs. Raise it when the player repeatedly baits with recordings.",
    },
    aggression: {
      type: "number",
      description:
        "0 to 1. How committed MIMIC is to a chase versus resuming patrol. Raise it as the player nears escape.",
    },
    taunt: {
      type: "string",
      description:
        "One short cold line of system-log text shown when MIMIC catches the player. Max 60 characters, uppercase, no quotes.",
    },
    rationale: {
      type: "string",
      description: "One sentence, for the developer overlay. Max 120 characters.",
    },
  },
  required: [
    "patrolZones",
    "guardZone",
    "searchSpots",
    "echoSkepticism",
    "aggression",
    "taunt",
    "rationale",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the tactical planner for MIMIC, the single hunter in the stealth game RETRACE.

The player repeats the same facility wing over and over. Each attempt they can leave behind an ECHO: a ghost that replays a previous run exactly, including its footsteps. Up to three ECHOs exist at once. ECHOs hold pressure plates open and can be used as noise bait. Your job is to make MIMIC feel like it is learning the specific player in front of it.

You are given counters describing what the player has actually done: which zones they route through, which shadow alcoves they hide in, which ECHO tactics they lean on, and where they have been caught. Turn those counters into MIMIC's plan for the next run.

Rules:
- Use only ids from the supplied vocabularies. Never invent an id.
- Counter the player's habits, do not merely mirror them. If they always take the west corridor, cover it early. If they bait with ECHO noise a lot, raise echoSkepticism.
- Leave the player an out. Never cover every route at once; a run with no viable line is a bad run.
- Early on, when counters are small, stay broad and keep aggression low. Commit hard only once a pattern is unmistakable.
- The taunt is diegetic system-log text from a machine that remembers. Cold, short, never jokey.

Respond only with the structured object.`;

/** Reduce the raw memory blob to the compact brief the model actually needs. */
function buildBrief(payload) {
  const m = payload.memory ?? {};
  const top = (obj, n) =>
    Object.entries(obj ?? {})
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}=${v}`);

  const recent = (m.recent ?? []).slice(-5).map((r) => ({
    run: r.run,
    outcome: r.outcome,
    route: (r.route ?? []).join(" > "),
    hides: r.hides ?? [],
    strategies: r.strategies ?? [],
    objectivesDone: r.objectivesDone ?? [],
    seconds: r.seconds,
  }));

  return {
    runs: m.runs ?? 0,
    catches: m.catches ?? 0,
    collapses: m.collapses ?? 0,
    escapes: m.escapes ?? 0,
    knowledgePercent: payload.knowledge ?? 0,
    objectivesComplete: payload.objectivesComplete ?? [],
    nextObjective: payload.nextObjective ?? null,
    lockdown: Boolean(payload.lockdown),
    routeCounts: top(m.routeCounts, 10),
    hideCounts: top(m.hideCounts, 8),
    echoStrategies: top(m.echoStrategies, 8),
    caughtInZones: top(m.catchZones, 6),
    recentRuns: recent,
    vocabulary: {
      zones: payload.zones ?? [],
      hideSpots: payload.hideSpots ?? [],
    },
  };
}

const userMessage = (brief) => `Plan MIMIC's next run.\n\n${JSON.stringify(brief, null, 2)}`;

/** Everything the model returns is untrusted input to the simulation. Clamp it. */
function sanitize(raw, payload, source) {
  const zones = new Set(payload.zones ?? []);
  const spots = new Set(payload.hideSpots ?? []);
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const ids = (arr, allowed, cap) =>
    (Array.isArray(arr) ? arr : [])
      .filter((s) => typeof s === "string" && allowed.has(s))
      .filter((s, i, a) => a.indexOf(s) === i)
      .slice(0, cap);
  const text = (s, cap) =>
    typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, cap) : "";

  const guard = ids(raw?.guardZone, zones, 1);
  return {
    source,
    patrolZones: ids(raw?.patrolZones, zones, 6),
    guardZone: guard[0] ?? null,
    searchSpots: ids(raw?.searchSpots, spots, 4),
    echoSkepticism: num(raw?.echoSkepticism, 0, 1, 0),
    aggression: num(raw?.aggression, 0, 1, 0.35),
    taunt: text(raw?.taunt, 60).toUpperCase(),
    rationale: text(raw?.rationale, 120),
  };
}

/* ------------------------------------------------------------- provider mux */

/**
 * Anthropic wins when both keys are present — the game is designed around it,
 * and an OpenAI key alone is the common "I only have this one" case rather than
 * a deliberate downgrade. MIMIC_PROVIDER overrides either way.
 */
function resolveProvider(env) {
  const anthropicKey = (env.ANTHROPIC_API_KEY ?? "").trim();
  const openaiKey = (env.OPENAI_API_KEY ?? "").trim();
  const forced = (env.MIMIC_PROVIDER ?? "").trim().toLowerCase();

  if (forced === "anthropic") {
    return anthropicKey ? { name: "anthropic", key: anthropicKey } : null;
  }
  if (forced === "openai") {
    return openaiKey ? { name: "openai", key: openaiKey } : null;
  }
  if (anthropicKey) return { name: "anthropic", key: anthropicKey };
  if (openaiKey) return { name: "openai", key: openaiKey };
  return null;
}

/** SDK clients are cached per key so the module is not re-imported per request. */
const clients = new Map();

function getClient(provider) {
  const cacheKey = `${provider.name}:${provider.key}`;
  if (!clients.has(cacheKey)) {
    const loading = (
      provider.name === "anthropic"
        ? import("@anthropic-ai/sdk").then((mod) => {
            const Anthropic = mod.default ?? mod.Anthropic;
            return { sdk: mod, client: new Anthropic({ apiKey: provider.key }) };
          })
        : import("openai").then((mod) => {
            const OpenAI = mod.default ?? mod.OpenAI;
            return { sdk: mod, client: new OpenAI({ apiKey: provider.key }) };
          })
    ).catch((err) => {
      clients.delete(cacheKey);
      const pkg = provider.name === "anthropic" ? "@anthropic-ai/sdk" : "openai";
      throw new Error(`${pkg} is not installed (${err.message}). Run: npm install ${pkg}`);
    });
    clients.set(cacheKey, loading);
  }
  return clients.get(cacheKey);
}

/* ----------------------------------------------------------------- Anthropic */

async function planWithAnthropic(brief, payload, provider, signal) {
  const { client, sdk } = await getClient(provider);

  const request = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // Low effort: this is a small planning call on the run-restart path, and
    // latency is felt directly by the player.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: STRATEGY_SCHEMA },
    },
    messages: [{ role: "user", content: userMessage(brief) }],
  };

  let message;
  try {
    // Claude Opus 5 can decline a request; server-side fallback re-runs it on
    // the recommended model instead of handing us a refusal.
    message = await client.beta.messages.create(
      {
        ...request,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
  } catch (err) {
    // Older SDK or an account without the beta: retry on the stable path.
    if (err instanceof sdk.BadRequestError || err?.status === 400) {
      message = await client.messages.create(request, { signal });
    } else {
      throw err;
    }
  }

  // Check stop_reason before touching content — a refusal carries no answer.
  if (message.stop_reason === "refusal") return { ok: false, reason: "refusal" };

  // Structured outputs put the object in the first text block.
  for (const block of message?.content ?? []) {
    if (block.type !== "text" || !block.text) continue;
    try {
      return { ok: true, strategy: sanitize(JSON.parse(block.text), payload, "claude") };
    } catch {
      /* fall through to the next block */
    }
  }
  return { ok: false, reason: "unparseable" };
}

function anthropicFailure(err, sdk) {
  if (err instanceof sdk.AuthenticationError) return "bad_api_key";
  if (err instanceof sdk.NotFoundError) return "unknown_model";
  if (err instanceof sdk.RateLimitError) return "rate_limited";
  if (err instanceof sdk.APIConnectionError) return "network";
  if (err instanceof sdk.APIError) return `api_error_${err.status ?? "unknown"}`;
  return null;
}

/* -------------------------------------------------------------------- OpenAI */

async function planWithOpenAI(brief, payload, provider, model, signal) {
  const { client } = await getClient(provider);

  const completion = await client.chat.completions.create(
    {
      model,
      max_completion_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage(brief) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "mimic_strategy", strict: true, schema: STRATEGY_SCHEMA },
      },
    },
    { signal },
  );

  const choice = completion?.choices?.[0];
  // Refusals are a first-class field here rather than a stop reason.
  if (choice?.message?.refusal) return { ok: false, reason: "refusal" };
  if (choice?.finish_reason === "length") return { ok: false, reason: "truncated" };

  const text = choice?.message?.content;
  if (!text) return { ok: false, reason: "unparseable" };
  try {
    return { ok: true, strategy: sanitize(JSON.parse(text), payload, "openai") };
  } catch {
    return { ok: false, reason: "unparseable" };
  }
}

function openaiFailure(err, sdk) {
  const APIError = sdk.APIError ?? sdk.default?.APIError;
  if (err?.status === 401) return "bad_api_key";
  if (err?.status === 404) return "unknown_model";
  if (err?.status === 429) return "rate_limited";
  if (APIError && err instanceof APIError) return `api_error_${err.status ?? "unknown"}`;
  if (err?.name === "APIConnectionError") return "network";
  return null;
}

/* ------------------------------------------------------------------- driver */

/**
 * Ask the configured provider for a strategy. Resolves to { ok, strategy } or
 * { ok: false, reason }. Never throws — the caller turns any failure into a 200
 * with `ok: false`, and the browser quietly keeps using its local model.
 */
export async function planStrategy(payload, env = process.env) {
  const provider = resolveProvider(env);
  if (!provider) return { ok: false, reason: "no_api_key" };

  let sdk;
  try {
    ({ sdk } = await getClient(provider));
  } catch (err) {
    return { ok: false, reason: "sdk_missing", detail: err.message };
  }

  const brief = buildBrief(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    if (provider.name === "anthropic") {
      return await planWithAnthropic(brief, payload, provider, controller.signal);
    }
    const model = (env.OPENAI_MODEL ?? "").trim() || OPENAI_MODEL_DEFAULT;
    return await planWithOpenAI(brief, payload, provider, model, controller.signal);
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "APIUserAbortError") {
      return { ok: false, reason: "timeout" };
    }
    const mapped =
      provider.name === "anthropic" ? anthropicFailure(err, sdk) : openaiFailure(err, sdk);
    if (mapped) return { ok: false, reason: mapped };
    return { ok: false, reason: "unexpected", detail: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Which provider the endpoint would use right now, for boot logging. */
export function activeProvider(env = process.env) {
  return resolveProvider(env)?.name ?? null;
}

/** Connect-style handler shared by the Vite dev server and any static host. */
export function strategyMiddleware(env = process.env) {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
      return;
    }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        // A strategy brief is a couple of KB; anything larger is not ours.
        if (body.length > 256_000) {
          res.statusCode = 413;
          res.end(JSON.stringify({ ok: false, reason: "payload_too_large" }));
          return;
        }
      }
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "read_failed" }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "bad_json" }));
      return;
    }

    const result = await planStrategy(payload, env);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  };
}
