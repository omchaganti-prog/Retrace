/**
 * The signal bus.
 *
 * Every puzzle component in RETRACE talks through named signals rather than
 * reaching into the thing it controls. A pressure plate does not know what door
 * it opens; it raises `gen.hold` and stops caring. A door does not know what
 * raised its condition; it evaluates an expression over the bus.
 *
 * That indirection is the whole point. It is what lets a door be opened by a
 * plate, a scanner, a sound sensor, MIMIC wandering through a scan arch, or any
 * combination — without a single line of per-puzzle wiring code. It is also what
 * makes reset safety tractable: clearing the bus resets every puzzle at once.
 *
 * Signals are 0..1 strength and live for exactly one tick unless something keeps
 * re-raising them. Anything that needs to persist (a latched relay, a timed
 * switch) is a component that keeps writing its signal, never a sticky value
 * hidden in the bus.
 */

/** A signal is "on" at or above this. */
export const SIGNAL_HIGH = 0.5;

export type SignalExpr =
  /** A bare signal id, on when its strength is at least SIGNAL_HIGH. */
  | string
  | { all: SignalExpr[] }
  | { any: SignalExpr[] }
  | { not: SignalExpr }
  /** On when at least `n` of the listed expressions are on. */
  | { atLeast: number; of: SignalExpr[] };

export class SignalBus {
  private now = new Map<string, number>();
  private prev = new Map<string, number>();

  /**
   * Raise a signal. Several emitters may drive the same id in a tick — the
   * strongest wins, so two bodies on one plate is still one held plate rather
   * than a doubled value.
   */
  raise(id: string, strength = 1): void {
    const cur = this.now.get(id) ?? 0;
    if (strength > cur) this.now.set(id, strength);
  }

  strength(id: string): number {
    return this.now.get(id) ?? 0;
  }

  isHigh(id: string): boolean {
    return this.strength(id) >= SIGNAL_HIGH;
  }

  private wasHigh(id: string): boolean {
    return (this.prev.get(id) ?? 0) >= SIGNAL_HIGH;
  }

  /** True on the tick a signal turns on — for one-shot log lines and sounds. */
  justRose(id: string): boolean {
    return this.isHigh(id) && !this.wasHigh(id);
  }

  justFell(id: string): boolean {
    return !this.isHigh(id) && this.wasHigh(id);
  }

  /** Every signal currently on, for the debug overlay. */
  active(): string[] {
    const out: string[] = [];
    for (const [id, v] of this.now) if (v >= SIGNAL_HIGH) out.push(id);
    return out.sort();
  }

  evaluate(expr: SignalExpr): boolean {
    if (typeof expr === "string") return this.isHigh(expr);
    if ("all" in expr) return expr.all.every((e) => this.evaluate(e));
    if ("any" in expr) return expr.any.some((e) => this.evaluate(e));
    if ("not" in expr) return !this.evaluate(expr.not);
    return expr.of.filter((e) => this.evaluate(e)).length >= expr.atLeast;
  }

  /** How many sub-expressions of an `atLeast` are satisfied — drives readouts. */
  countOf(exprs: SignalExpr[]): number {
    return exprs.filter((e) => this.evaluate(e)).length;
  }

  /**
   * Roll the frame, then let the components write. Called at the *start* of the
   * tick rather than the end, so the bus still holds the current frame's state
   * once the tick returns — the renderer, the HUD and the debug overlay all read
   * it from outside the simulation, and clearing on the way out left every one
   * of them looking at an empty bus.
   */
  beginTick(): void {
    const spare = this.prev;
    spare.clear();
    for (const [k, v] of this.now) spare.set(k, v);
    this.prev = spare;
    this.now = this.now === spare ? new Map() : this.now;
    this.now.clear();
  }

  /** Full wipe, for a RETRACE or a collapse. */
  clear(): void {
    this.now.clear();
    this.prev.clear();
  }

  /** Every signal named anywhere in an expression, for debug display. */
  static idsIn(expr: SignalExpr): string[] {
    if (typeof expr === "string") return [expr];
    if ("all" in expr) return expr.all.flatMap(SignalBus.idsIn);
    if ("any" in expr) return expr.any.flatMap(SignalBus.idsIn);
    if ("not" in expr) return SignalBus.idsIn(expr.not);
    return expr.of.flatMap(SignalBus.idsIn);
  }
}

/** Human-readable form of an expression, for the schematic and debug overlay. */
export function describeExpr(expr: SignalExpr, name: (id: string) => string): string {
  if (typeof expr === "string") return name(expr);
  if ("all" in expr) return expr.all.map((e) => describeExpr(e, name)).join(" + ");
  if ("any" in expr) return expr.any.map((e) => describeExpr(e, name)).join(" / ");
  if ("not" in expr) return `NOT ${describeExpr(expr.not, name)}`;
  return `${expr.atLeast} OF [${expr.of.map((e) => describeExpr(e, name)).join(" ")}]`;
}
