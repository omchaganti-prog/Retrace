/**
 * Keyboard state. Movement is sampled per simulation tick; discrete actions are
 * consumed as edge-triggered "pressed" events so a single keypress can never be
 * recorded twice into an ECHO.
 */
export interface InputSnapshot {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  /** Held to move slowly and almost silently. */
  sneak: boolean;
  /** Held to charge a dash. */
  dash: boolean;
}

const CODE_MAP: Record<string, keyof InputSnapshot> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
  ControlLeft: "sneak",
  ControlRight: "sneak",
  KeyC: "sneak",
  Space: "dash",
};

export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private heldFor = new Map<string, number>();
  readonly state: InputSnapshot = {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    sneak: false,
    dash: false,
  };

  /** Set while the window has focus; used to auto-pause. */
  focused = true;

  attach(target: Window = window): () => void {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Keep browser shortcuts like devtools/reload working, swallow game keys.
      if (CODE_MAP[e.code] || GAME_KEYS.has(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressedThisFrame.add(e.code);
      this.heldFor.set(e.code, 0);
      this.sync();
    };
    const onUp = (e: KeyboardEvent) => {
      this.down.delete(e.code);
      this.heldFor.delete(e.code);
      this.sync();
    };
    const onBlur = () => {
      this.down.clear();
      this.heldFor.clear();
      this.focused = false;
      this.sync();
    };
    const onFocus = () => {
      this.focused = true;
    };

    target.addEventListener("keydown", onDown);
    target.addEventListener("keyup", onUp);
    target.addEventListener("blur", onBlur);
    target.addEventListener("focus", onFocus);
    return () => {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      target.removeEventListener("blur", onBlur);
      target.removeEventListener("focus", onFocus);
    };
  }

  private sync(): void {
    this.state.up = false;
    this.state.down = false;
    this.state.left = false;
    this.state.right = false;
    this.state.sprint = false;
    this.state.sneak = false;
    this.state.dash = false;
    for (const code of this.down) {
      const slot = CODE_MAP[code];
      if (slot) this.state[slot] = true;
    }
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True exactly once per physical keypress. */
  consumePress(code: string): boolean {
    if (!this.pressedThisFrame.has(code)) return false;
    this.pressedThisFrame.delete(code);
    return true;
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /** Seconds the key has been held, or 0 if it is up. */
  holdTime(code: string): number {
    return this.heldFor.get(code) ?? 0;
  }

  advance(dt: number): void {
    for (const [code, t] of this.heldFor) this.heldFor.set(code, t + dt);
  }

  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  clear(): void {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.heldFor.clear();
    this.sync();
  }
}

const GAME_KEYS = new Set([
  "KeyE",
  "KeyR",
  "KeyM",
  "F1",
  "Escape",
  "Space",
  "Enter",
  "Tab",
  // Eye-state stepping, diagnostics only.
  "BracketLeft",
  "BracketRight",
]);
