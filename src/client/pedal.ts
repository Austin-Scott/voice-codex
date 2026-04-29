export interface PedalBindings {
  agent: string;
  whisper: string;
  action: string;
}

export interface PedalHandlers {
  onAgentDown: () => void;
  onAgentUp: () => void;
  onWhisperDown: () => void;
  onWhisperUp: () => void;
  onActionEnter: () => void;
  onActionEsc: () => void;
}

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

export const DEFAULT_PEDAL_BINDINGS: PedalBindings = {
  agent: "F13",
  whisper: "F14",
  action: "F15"
};

export class TapDoubleHoldGesture {
  private pressStart = 0;
  private pendingEnter: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onEnter: () => void,
    private readonly onEsc: () => void,
    private readonly options = { holdMs: 500, doubleTapMs: 260 },
    private readonly now = () => Date.now()
  ) {}

  down(): void {
    this.pressStart = this.now();
  }

  up(): void {
    const duration = this.now() - this.pressStart;
    if (duration >= this.options.holdMs) {
      this.clearPendingEnter();
      return;
    }

    if (this.pendingEnter) {
      this.clearPendingEnter();
      this.onEsc();
      return;
    }

    this.pendingEnter = setTimeout(() => {
      this.pendingEnter = undefined;
      this.onEnter();
    }, this.options.doubleTapMs);
  }

  dispose(): void {
    this.clearPendingEnter();
  }

  private clearPendingEnter(): void {
    if (this.pendingEnter) {
      clearTimeout(this.pendingEnter);
      this.pendingEnter = undefined;
    }
  }
}

export class PedalInput {
  private pressed = new Set<string>();
  private actionGesture: TapDoubleHoldGesture;

  constructor(private bindings: PedalBindings, private readonly handlers: PedalHandlers) {
    this.actionGesture = new TapDoubleHoldGesture(handlers.onActionEnter, handlers.onActionEsc);
  }

  setBindings(bindings: PedalBindings): void {
    this.bindings = bindings;
  }

  keyDown(event: KeyboardEvent): boolean {
    const code = event.code;
    if (this.pressed.has(code)) {
      return this.matches(code);
    }

    if (code === this.bindings.agent) {
      this.pressed.add(code);
      this.handlers.onAgentDown();
      return true;
    }

    if (code === this.bindings.whisper) {
      this.pressed.add(code);
      this.handlers.onWhisperDown();
      return true;
    }

    if (code === this.bindings.action) {
      this.pressed.add(code);
      this.actionGesture.down();
      return true;
    }

    return false;
  }

  keyUp(event: KeyboardEvent): boolean {
    const code = event.code;
    if (!this.pressed.delete(code)) {
      return false;
    }

    if (code === this.bindings.agent) {
      this.handlers.onAgentUp();
      return true;
    }

    if (code === this.bindings.whisper) {
      this.handlers.onWhisperUp();
      return true;
    }

    if (code === this.bindings.action) {
      this.actionGesture.up();
      return true;
    }

    return false;
  }

  dispose(): void {
    this.actionGesture.dispose();
  }

  private matches(code: string): boolean {
    return code === this.bindings.agent || code === this.bindings.whisper || code === this.bindings.action;
  }
}

export class TouchButtonInput {
  private active:
    | {
        count: number;
        center: { x: number; y: number };
        canceled: boolean;
        pttStarted: boolean;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private actionGesture: TapDoubleHoldGesture;

  constructor(
    private readonly handlers: PedalHandlers,
    private readonly options = { stationaryMs: 180, movementPx: 18 }
  ) {
    this.actionGesture = new TapDoubleHoldGesture(handlers.onActionEnter, handlers.onActionEsc);
  }

  start(points: TouchPoint[]): boolean {
    this.cancel();
    if (points.length < 1 || points.length > 3) {
      return false;
    }

    const count = points.length;
    this.active = {
      count,
      center: centerOf(points),
      canceled: false,
      pttStarted: false
    };

    if (count === 1 || count === 2) {
      this.active.timer = setTimeout(() => {
        if (!this.active || this.active.canceled || this.active.pttStarted) {
          return;
        }
        this.active.pttStarted = true;
        if (count === 1) {
          this.handlers.onAgentDown();
        } else {
          this.handlers.onWhisperDown();
        }
      }, this.options.stationaryMs);
    } else {
      this.actionGesture.down();
    }

    return true;
  }

  move(points: TouchPoint[]): boolean {
    if (!this.active) {
      return false;
    }

    const distance = distanceBetween(this.active.center, centerOf(points));
    if (distance > this.options.movementPx) {
      this.cancel();
      return false;
    }

    return this.active.pttStarted || this.active.count === 3;
  }

  end(): boolean {
    if (!this.active) {
      return false;
    }

    const active = this.active;
    this.active = undefined;
    if (active.timer) {
      clearTimeout(active.timer);
    }

    if (active.canceled) {
      return false;
    }

    if (active.count === 1 && active.pttStarted) {
      this.handlers.onAgentUp();
      return true;
    }

    if (active.count === 2 && active.pttStarted) {
      this.handlers.onWhisperUp();
      return true;
    }

    if (active.count === 3) {
      this.actionGesture.up();
      return true;
    }

    return false;
  }

  cancel(): void {
    if (!this.active) {
      return;
    }

    const active = this.active;
    this.active = undefined;
    active.canceled = true;
    if (active.timer) {
      clearTimeout(active.timer);
    }

    if (active.count === 1 && active.pttStarted) {
      this.handlers.onAgentUp();
    }

    if (active.count === 2 && active.pttStarted) {
      this.handlers.onWhisperUp();
    }
  }

  dispose(): void {
    this.cancel();
    this.actionGesture.dispose();
  }
}

function centerOf(points: TouchPoint[]): { x: number; y: number } {
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 }
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function distanceBetween(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
