# RETRACE

A 2D top-down sci-fi stealth game where **your only weapon is your own past**.

You cannot fight. You cannot outrun the thing hunting you. What you *can* do is
record a run of the facility and play it back — a frame-accurate ghost of
yourself called an **ECHO** that walks the route you walked, holds the switch
you held, and makes the noise you made. The puzzles are built so no single body
can solve them. You solve them by cooperating with the people you used to be.

Built in TypeScript with Vite. No game engine, and no art or audio files —
every sprite, sound and piece of music is generated procedurally at boot.

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

```bash
npm run build     # typecheck + production build to dist/
npm test          # the full suite
```

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Move |
| `Shift` | Sprint — fast and loud |
| `Ctrl` or `C` | Sneak — slow and almost silent |
| `Space` | Hold to charge a dash, release to fire |
| `E` | Interact |
| **Hold `R`** | **RETRACE — bank this run as an ECHO** |
| `Escape` | Pause |
| `M` | Mute audio |
| `F1` | Diagnostics overlay |

While paused, `1`–`4` toggle accessibility settings: screen shake, glitch,
flashing, and whether MIMIC's footsteps are audible.

## How it works

**RETRACE.** Holding `R` ends the current run and banks everything you just did
as an ECHO. The next run replays it beside you on a shared clock. You can hold
up to three at once, so at full strength there are four of you in the building.

**MIMIC.** The hunter is not on a fixed patrol. It hears you — sound propagates
through the level as a flood-filled field, so sprinting round a corner carries
further than sneaking in the open. It watches through a vision cone clipped
against real geometry, and unlit alcoves hide you from it. Most of all, it
*learns*: which corridors you favour, which alcoves you hide in, whether you
lean on recorded noise as bait. That memory survives your resets. Its file on
you is readable on the facility's own terminals.

**The three layers of state.** RETRACE wipes the timeline, but not what you
know, and not what MIMIC has learned about you. Losing is not losing progress.

**Temporal Stability** is your health: three points. Getting caught costs one
and corrupts the screen a little further. At zero the timeline collapses, your
ECHOs are wiped, and MIMIC's memory of you decays — but your completed
objectives survive. A run cannot become unwinnable.

## The campaign

Three systems stand between you and the surface lift:

1. **Generator intake** — a clamp at the far end of a chamber has to be held
   down while you walk through the hatch it controls. One body cannot do both.
2. **Security authorization** — two pressure plates, far apart, weighted at the
   same moment. Two past selves, recorded separately, standing together.
3. **Containment clearance** — an arch that only reads containment-grade
   signatures. You cannot produce one. The only thing in the wing that can is
   the thing hunting you, so you have to make noise in the laboratory and let
   MIMIC walk through the arch chasing you.

Other puzzles — a three-stage relay cascade, a four-signature array, an
acoustic chamber that listens for a recorded dash, a camera you bait with a
decoy — are optional, and worth doing.

## Under the hood

- **Fixed 60 Hz simulation.** ECHO recordings are frame-indexed against it, so
  playback is exact rather than approximate.
- **Grid raycasting** (Amanatides–Woo) for line of sight and vision cones.
- **Dijkstra sound propagation** — one shared field drives what MIMIC hears,
  what the microphones hear, and how muffled a sound is when you hear it.
- **A\*** pathfinding for MIMIC and its searches.
- **Signal-bus puzzles.** Components raise named signals; doors evaluate
  expressions over them (`all`, `any`, `not`, `atLeast`). Neither knows the
  other exists, so any machine can drive any door.
- **Procedural everything.** Sprites are drawn into offscreen canvases at boot;
  audio is layered synthesised voices through a limiter, with occlusion applied
  as a low-pass filter rather than a volume cut.
- **307 tests** covering the systems and, end to end, that the game is winnable
  and cannot be permanently lost.

## Optional: the remote strategist

MIMIC plans its patrols with a local learning model by default. Give it an API
key and it will use a language model to plan instead — the HUD switches from
`MIMIC LINK: LOCAL` to `CLAUDE` or `GPT`.

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
The key is read in the Node process only and never reaches the browser bundle.
This endpoint runs under `npm run dev` and `npm run preview`; a static
deployment simply falls back to the local model.
