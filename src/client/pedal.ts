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
