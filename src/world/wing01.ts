/**
 * WING-01 — the vertical slice.
 *
 * Objective chain: Restore Power -> Obtain Authorization -> Disable Containment
 * -> Escape. Each security gate needs one more simultaneously-held pressure
 * plate than the last, which forces the ECHO count up:
 *
 *   GATE ALPHA -> 1 plate  -> 1 ECHO holds it while you walk through
 *   GATE BETA  -> 2 plates -> 2 ECHOs
 *   GATE GAMMA -> 3 plates -> 3 ECHOs (the design cap) + you
 *
 * Each objective room hangs off exactly one gate, so the gates cannot be
 * bypassed. Plates are scattered across separate zones so every one costs its
 * own run to set up — and every run teaches MIMIC another one of your routes.
 *
 * Two routes connect the spine to the south side (WEST_HALL and EAST_HALL).
 * Which one you favour is the main thing MIMIC's route memory picks up on.
 */
import { type LevelDef, r } from "./level";
import { Tile } from "./tiles";

const F = Tile.Floor;
const W = Tile.Wall;
const G = Tile.Grate;
const S = Tile.Shadow;

export const WING01: LevelDef = {
  id: "wing01",
  name: "WING-01 // CONTAINMENT ANNEX",
  w: 66,
  h: 46,

  carve: [
    // --- rooms -------------------------------------------------------------
    { area: r(3, 34, 15, 42), tile: F }, // START   — reclamation bay
    { area: r(3, 4, 16, 12), tile: F }, // POWER   — reactor sub-station
    { area: r(27, 3, 40, 10), tile: F }, // VAULT   — authorization suite
    { area: r(46, 19, 60, 31), tile: F }, // CONTAIN — containment control
    { area: r(52, 34, 60, 41), tile: F }, // ESCAPE  — surface lift bay
    { area: r(19, 19, 42, 32), tile: F }, // MAZE    — service warren

    // --- puzzle wings ------------------------------------------------------
    // Carved into blocks the original layout left solid, so the existing routes
    // and every distance MIMIC has already learned are untouched.
    { area: r(10, 18, 17, 24), tile: F }, // GENERATOR WING
    { area: r(10, 27, 17, 33), tile: F }, // SECURITY WING
    { area: r(43, 3, 62, 12), tile: F }, // TEMPORAL LABORATORY

    // --- primary corridors -------------------------------------------------
    { area: r(4, 14, 64, 16), tile: F }, // TOP_HALL, the spine
    { area: r(5, 18, 7, 33), tile: F }, // WEST_HALL
    { area: r(62, 17, 64, 43), tile: F }, // EAST_HALL
    { area: r(16, 37, 50, 39), tile: F }, // SOUTH_HALL
    { area: r(50, 40, 50, 43), tile: F }, // south -> bottom run
    { area: r(50, 43, 62, 43), tile: F }, // bottom run -> EAST_HALL

    // --- connectors (1 tile wide, so a single door plugs each one) ----------
    { area: r(9, 13, 9, 13), tile: F }, // POWER   <-> TOP_HALL  (GATE ALPHA)
    { area: r(33, 11, 33, 13), tile: F }, // VAULT   <-> TOP_HALL  (GATE BETA)
    { area: r(53, 17, 53, 18), tile: F }, // CONTAIN <-> TOP_HALL  (GATE GAMMA)
    { area: r(51, 38, 51, 38), tile: F }, // SOUTH   <-> ESCAPE    (BULKHEAD)
    { area: r(6, 17, 6, 17), tile: F }, // WEST_HALL <-> TOP_HALL
    { area: r(8, 25, 18, 25), tile: F }, // WEST_HALL <-> MAZE
    { area: r(25, 17, 25, 18), tile: F }, // TOP_HALL  <-> MAZE
    { area: r(31, 33, 31, 36), tile: F }, // MAZE      <-> SOUTH_HALL
    { area: r(8, 20, 9, 20), tile: F }, // WEST_HALL <-> GENERATOR
    { area: r(8, 30, 9, 30), tile: F }, // WEST_HALL <-> SECURITY
    { area: r(18, 30, 18, 30), tile: F }, // SECURITY  <-> MAZE (service hatch)
    { area: r(52, 13, 52, 13), tile: F }, // LAB       <-> TOP_HALL

    // --- puzzle-wing internal partitions ------------------------------------
    // The generator is two chambers with one hatch between them. The clamp that
    // holds the hatch open is in the outer chamber and cannot be reached from
    // the inner one — the wall must span the full room or the puzzle has a
    // bypass and teaches nothing.
    { area: r(10, 21, 17, 21), tile: W },
    // The laboratory is three bays joined only at row 6, so each door is a real
    // chokepoint: vault | array + arch | orchestra.
    { area: r(48, 3, 48, 5), tile: W },
    { area: r(48, 7, 48, 12), tile: W },
    { area: r(56, 3, 56, 5), tile: W },
    { area: r(56, 7, 56, 12), tile: W },

    // --- maze pillars ------------------------------------------------------
    { area: r(22, 19, 23, 24), tile: W },
    { area: r(22, 28, 23, 32), tile: W },
    { area: r(27, 21, 28, 26), tile: W },
    { area: r(27, 29, 28, 32), tile: W },
    { area: r(32, 19, 33, 23), tile: W },
    { area: r(32, 26, 33, 31), tile: W },
    { area: r(37, 21, 38, 27), tile: W },
    { area: r(37, 30, 38, 32), tile: W },
    // Containment baffles.
    { area: r(50, 22, 51, 27), tile: W },
    { area: r(55, 24, 56, 29), tile: W },

    // --- surface detail ----------------------------------------------------
    { area: r(10, 15, 20, 15), tile: G }, // loud grating: fast route, noisy
    { area: r(20, 38, 30, 38), tile: G },
    { area: r(62, 20, 64, 24), tile: G },
    // Unlit alcoves: walkable, quieter underfoot, and far harder to be seen in.
    // Every one of these must sit wholly inside an already-carved floor region —
    // a stray tile would punch a hole straight through a wall.
    { area: r(5, 30, 7, 32), tile: S }, // WEST_HALL
    { area: r(20, 20, 21, 22), tile: S }, // MAZE, north-west
    { area: r(40, 29, 41, 31), tile: S }, // MAZE, south-east
    { area: r(57, 19, 59, 21), tile: S }, // CONTAIN
    { area: r(12, 40, 14, 42), tile: S }, // START
    { area: r(62, 34, 64, 37), tile: S }, // EAST_HALL

    // The objective rooms and the long runs between them had no cover at all,
    // which made every forced stop — interacting, waiting out a sweep — a coin
    // flip. One bolt-hole each, so there is always somewhere to break line of
    // sight without crossing the map.
    { area: r(14, 10, 16, 12), tile: S }, // POWER, behind the reactor
    { area: r(27, 8, 29, 10), tile: S }, // VAULT, under the mezzanine
    { area: r(43, 15, 45, 16), tile: S }, // TOP_HALL, a recess off the spine
    { area: r(29, 27, 30, 28), tile: S }, // MAZE, dead centre between pillars
    { area: r(46, 37, 48, 38), tile: S }, // SOUTH_HALL, east of the camera
    { area: r(52, 40, 53, 41), tile: S }, // ESCAPE, beside the lift
  ],

  doors: [
    {
      id: "gate_alpha",
      tx: 9,
      ty: 13,
      label: "GATE ALPHA",
      rule: { kind: "plates", plates: ["plate_a"] },
    },
    {
      id: "gate_beta",
      tx: 33,
      ty: 11,
      label: "GATE BETA",
      rule: { kind: "plates", plates: ["plate_b", "plate_c"] },
    },
    {
      id: "gate_gamma",
      tx: 53,
      ty: 17,
      label: "GATE GAMMA",
      rule: { kind: "plates", plates: ["plate_d", "plate_e", "plate_f"] },
    },
    {
      id: "gate_omega",
      tx: 51,
      ty: 38,
      label: "LIFT BULKHEAD",
      // The three systems the campaign actually requires. This list and
      // REQUIRED_OBJECTIVES have to agree — the bulkhead asking for a system the
      // checklist never mentions is an unwinnable run with no explanation.
      rule: { kind: "flags", flags: ["intake", "auth", "clearance"] },
    },
    /* ------------------------------------------------ puzzle-wing doors */
    // TIER 1. The clamp is in the outer chamber; this door is the only way into
    // the inner one, and it only holds while the clamp is weighted. One body
    // cannot do both, which is the entire lesson.
    {
      id: "gen_inner",
      tx: 11,
      ty: 21,
      label: "INTAKE HATCH",
      rule: { kind: "signal", expr: "gen.clamp" },
    },
    // TIER 2/3. Two keys in one window, then the cascade in order.
    {
      id: "gen_auth",
      tx: 18,
      ty: 22,
      label: "GENERATOR GATE",
      rule: { kind: "signal", expr: { any: ["auth.ok", "relay.ok"] } },
    },
    // TIER 5/6/8. Three ways past the same checkpoint: satisfy the microphones,
    // spend a decoy contact on the camera, or catch its override on cooldown.
    // Multiple solutions by construction, not by accident.
    {
      id: "sec_checkpoint",
      tx: 18,
      ty: 30,
      label: "SECURITY CHECKPOINT",
      rule: { kind: "signal", expr: { any: ["mic.ok", "bait.relay", "override.spent"] } },
    },
    // TIER 7. No key the player will ever hold — the only containment-grade
    // signature in the wing belongs to the thing hunting them.
    {
      id: "lab_arch",
      tx: 56,
      ty: 6,
      label: "RESTRICTED BAY",
      rule: { kind: "signal", expr: "arch.ok" },
    },
    // TIER 4 + 9. The vault the whole laboratory exists to open. Either proof
    // of four simultaneous instances will do — the array, or the performance.
    {
      id: "lab_vault",
      tx: 48,
      ty: 6,
      label: "TEMPORAL VAULT",
      rule: { kind: "signal", expr: { any: ["sig.ok", "orchestra.ok"] } },
    },
    { mimicControllable: true, id: "hatch_lab", tx: 52, ty: 13, rule: { kind: "auto" } },
    { mimicControllable: true, id: "hatch_gen", tx: 9, ty: 20, rule: { kind: "auto" } },
    { mimicControllable: true, id: "hatch_sec", tx: 9, ty: 30, rule: { kind: "auto" } },
    { mimicControllable: true, id: "hatch_west", tx: 6, ty: 17, rule: { kind: "auto" } },
    { mimicControllable: true, id: "hatch_maze_w", tx: 9, ty: 25, rule: { kind: "auto" } },
    { mimicControllable: true, id: "hatch_maze_n", tx: 25, ty: 17, rule: { kind: "auto" } },
    { mimicControllable: true, id: "hatch_south", tx: 31, ty: 34, rule: { kind: "auto" } },
  ],

  props: [
    // Objective devices.
    {
      id: "reactor_lever",
      kind: "lever",
      tx: 5,
      ty: 5,
      label: "REACTOR INTERLOCK",
      objective: "power",
      // The interlock is dead until the generator intake is authorised, so the
      // first thing the campaign asks for is a past self holding a clamp.
      requires: ["intake"],
    },
    {
      id: "auth_terminal",
      kind: "terminal",
      tx: 33,
      ty: 4,
      label: "AUTHORIZATION TERMINAL",
      objective: "auth",
      // Needs the generator cascade carrying load: two clamps and a breaker.
      // Only the intake, which is also required. Waiting on the reactor or the
      // cascade would put an optional stage in the middle of the critical path,
      // which is the long road wearing a disguise.
      requires: ["intake"],
    },
    {
      id: "containment_console",
      kind: "console",
      tx: 48,
      ty: 20,
      label: "CONTAINMENT CONSOLE",
      objective: "containment",
      // And the containment override needs the temporal bypass the signature
      // array proves — four instances of Subject 047 at once.
      requires: ["power", "auth", "bypass"],
    },
    { id: "surface_lift", kind: "exit", tx: 56, ty: 37, label: "SURFACE LIFT" },

    {
      id: "wiring_schematic",
      kind: "terminal",
      tx: 5,
      ty: 36,
      label: "FACILITY SCHEMATIC",
    },

    // Pressure plates, one cluster per gate.
    { id: "plate_a", kind: "plate", label: "PLATE A", tx: 21, ty: 15 },
    { id: "plate_b", kind: "plate", label: "PLATE B", tx: 26, ty: 25 },
    { id: "plate_c", kind: "plate", label: "PLATE C", tx: 40, ty: 15 },
    { id: "plate_d", kind: "plate", label: "PLATE D", tx: 12, ty: 25 },
    { id: "plate_e", kind: "plate", label: "PLATE E", tx: 63, ty: 30 },
    { id: "plate_f", kind: "plate", label: "PLATE F", tx: 31, ty: 35 },

    /* ------------------------------------------------ puzzle-wing devices */
    // Dual authentication: one key each side of the intake hatch. Their windows
    // must overlap, and the only way to be in both chambers inside one window is
    // for somebody else to be holding the clamp — so the geometry, not a tight
    // timer, is what makes this need two bodies.
    { id: "gen_key_a", kind: "lever", tx: 12, ty: 19, label: "KEY ALPHA" },
    { id: "gen_key_b", kind: "lever", tx: 16, ty: 22, label: "KEY BETA" },
    // The cascade's breaker. Clamps A and B are floor pads, not props — weight
    // has to be on both when this throws.
    { id: "gen_relay_c", kind: "console", tx: 17, ty: 24, label: "BREAKER" },
    // The laboratory's own schematic, in the entrance bay so the wing explains
    // itself before it asks anything.
    { id: "lab_schematic", kind: "terminal", tx: 52, ty: 3, label: "LAB SCHEMATIC" },
    /* ------------------------------------------------ story terminals */
    // Placed so the story is walked past, not detoured to. Every one of these
    // sits on a route the campaign already sends the player down.

    // Observation corridor, at the mouth of the laboratory: MIMIC gets a name
    // and a stated purpose before it is ever a threat.
    { id: "term_mimic", kind: "terminal", tx: 50, ty: 14, label: "MONITORING CORE" },
    // Reclamation bay, beside the spawn. The first thing worth reading, and the
    // one carrying the glitch.
    { id: "term_trials", kind: "terminal", tx: 7, ty: 36, label: "TRIAL RECORDS" },
    // Security wing: the facility's file on how the player actually plays.
    { id: "term_behaviour", kind: "terminal", tx: 16, ty: 27, label: "BEHAVIOR ANALYSIS" },

    // The archives, in the abandoned west bay of the laboratory — the room the
    // Old ECHO crosses. Reached only once the signature array is solved.
    { id: "term_archive", kind: "terminal", tx: 44, ty: 4, label: "ARCHIVE // RESTORATIONS" },
    { id: "term_memory", kind: "terminal", tx: 46, ty: 4, label: "ARCHIVE // MEMORY" },
    { id: "term_purpose", kind: "terminal", tx: 44, ty: 10, label: "ARCHIVE // CHARTER" },
    { id: "term_containment", kind: "terminal", tx: 46, ty: 10, label: "ARCHIVE // STANDING ORDER" },

    // What the array and the orchestra are both for.
    { id: "temporal_vault", kind: "terminal", tx: 45, ty: 7, label: "TEMPORAL VAULT" },

    // A camera watching the security wing. This is the one an ECHO is meant to
    // walk in front of on purpose.
    {
      id: "cam_security",
      kind: "camera",
      tx: 11,
      ty: 32,
      facing: 0,
      sweep: 0.5,
      sweepPeriod: 5.5,
    },

    // Cameras cannot catch you — they hand your position to MIMIC.
    {
      id: "cam_spine",
      kind: "camera",
      tx: 36,
      ty: 14,
      facing: Math.PI / 2,
      sweep: 0.85,
      sweepPeriod: 7.5,
    },
    {
      id: "cam_south",
      kind: "camera",
      tx: 41,
      ty: 37,
      facing: Math.PI,
      sweep: 0.7,
      sweepPeriod: 6,
    },
  ],

  zones: [
    { id: "start", label: "RECLAMATION BAY", rects: [r(3, 34, 15, 42)] },
    { id: "west_hall", label: "WEST CORRIDOR", rects: [r(5, 18, 7, 33)] },
    { id: "top_hall", label: "SPINE CORRIDOR", rects: [r(4, 14, 64, 16)] },
    { id: "east_hall", label: "EAST CORRIDOR", rects: [r(62, 17, 64, 43)] },
    { id: "south_hall", label: "SOUTH CORRIDOR", rects: [r(16, 37, 50, 39)] },
    { id: "power", label: "REACTOR SUB-STATION", rects: [r(3, 4, 16, 12)] },
    { id: "vault", label: "AUTHORIZATION SUITE", rects: [r(27, 3, 40, 10)] },
    { id: "maze", label: "SERVICE WARREN", rects: [r(19, 19, 42, 32)] },
    { id: "contain", label: "CONTAINMENT CONTROL", rects: [r(46, 19, 60, 31)] },
    { id: "escape", label: "SURFACE LIFT BAY", rects: [r(52, 34, 60, 41)] },
    { id: "generator", label: "GENERATOR WING", rects: [r(10, 18, 17, 24)] },
    { id: "security", label: "SECURITY WING", rects: [r(10, 27, 17, 33)] },
    { id: "lab", label: "TEMPORAL LABORATORY", rects: [r(43, 3, 62, 12)] },
  ],

  playerSpawn: { tx: 8, ty: 38 },
  mimicSpawn: { tx: 30, ty: 15 },

  patrolNodes: [
    { id: "n_spine_w", tx: 12, ty: 15 },
    { id: "n_spine_m", tx: 30, ty: 15 },
    { id: "n_spine_e", tx: 58, ty: 15 },
    { id: "n_west", tx: 6, ty: 28 },
    { id: "n_maze_nw", tx: 21, ty: 24 },
    { id: "n_maze_c", tx: 30, ty: 25 },
    { id: "n_maze_se", tx: 41, ty: 27 },
    { id: "n_south_w", tx: 20, ty: 38 },
    { id: "n_south_e", tx: 46, ty: 38 },
    { id: "n_east", tx: 63, ty: 28 },
    { id: "n_bottom", tx: 56, ty: 43 },
    { id: "n_start", tx: 9, ty: 38 },
    { id: "n_maze_join", tx: 31, ty: 35 },
    // Inside the containment arch at the laboratory mouth. Without a patrol node
    // here MIMIC has no reason to ever enter the lab, and the clearance stage
    // would depend on the player luring it there with no guarantee it works.
    { id: "n_lab_arch", tx: 52, ty: 12, mandatory: true },
  ],

  // One marker per alcove. MIMIC sweeps these by name when it loses you, and
  // your memory of which ones you lean on is what it learns to check first —
  // so an alcove without a marker is a blind spot, and a marker without an
  // alcove sends it hunting bare floor. Kept in step by a test.
  hideSpots: [
    { id: "hide_west_alcove", tx: 6, ty: 31 },
    { id: "hide_maze_nw", tx: 20, ty: 21 },
    { id: "hide_maze_se", tx: 40, ty: 30 },
    { id: "hide_east_nook", tx: 63, ty: 35 },
    { id: "hide_start_nook", tx: 13, ty: 41 },
    { id: "hide_contain_nook", tx: 58, ty: 20 },
    { id: "hide_power_bay", tx: 15, ty: 11 },
    { id: "hide_vault_stack", tx: 28, ty: 9 },
    { id: "hide_spine_recess", tx: 44, ty: 16 },
    { id: "hide_maze_core", tx: 29, ty: 27 },
    { id: "hide_south_bend", tx: 47, ty: 38 },
    { id: "hide_lift_corner", tx: 52, ty: 41 },
  ],
};
