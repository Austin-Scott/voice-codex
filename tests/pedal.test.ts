import { describe, expect, it, vi } from "vitest";
import { TapDoubleHoldGesture, TouchButtonInput } from "../src/client/pedal";

describe("TapDoubleHoldGesture", () => {
  it("sends enter after a single tap", () => {
    vi.useFakeTimers();
    let now = 0;
    const actions: string[] = [];
    const gesture = new TapDoubleHoldGesture(
      () => actions.push("enter"),
      () => actions.push("esc"),
      { holdMs: 500, doubleTapMs: 260 },
      () => now
    );

    gesture.down();
    now += 80;
    gesture.up();
    expect(actions).toEqual([]);

    vi.advanceTimersByTime(260);
    expect(actions).toEqual(["enter"]);
    vi.useRealTimers();
  });

  it("sends escape on a double tap", () => {
    vi.useFakeTimers();
    let now = 0;
    const actions: string[] = [];
    const gesture = new TapDoubleHoldGesture(
      () => actions.push("enter"),
      () => actions.push("esc"),
      { holdMs: 500, doubleTapMs: 260 },
      () => now
    );

    gesture.down();
    now += 70;
    gesture.up();
    now += 100;
    gesture.down();
    now += 70;
    gesture.up();

    vi.advanceTimersByTime(300);
    expect(actions).toEqual(["esc"]);
    vi.useRealTimers();
  });

  it("does nothing for a hold and release", () => {
    vi.useFakeTimers();
    let now = 0;
    const actions: string[] = [];
    const gesture = new TapDoubleHoldGesture(
      () => actions.push("enter"),
      () => actions.push("esc"),
      { holdMs: 500, doubleTapMs: 260 },
      () => now
    );

    gesture.down();
    now += 700;
    gesture.up();
    vi.advanceTimersByTime(300);

    expect(actions).toEqual([]);
    vi.useRealTimers();
  });
});

describe("TouchButtonInput", () => {
  it("maps one stationary finger hold to agent push-to-talk", () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const input = new TouchButtonInput(
      {
        onAgentDown: () => actions.push("agentDown"),
        onAgentUp: () => actions.push("agentUp"),
        onWhisperDown: () => actions.push("whisperDown"),
        onWhisperUp: () => actions.push("whisperUp"),
        onActionEnter: () => actions.push("enter"),
        onActionEsc: () => actions.push("esc")
      },
      { stationaryMs: 100, movementPx: 10 }
    );

    input.start([{ id: 1, x: 10, y: 10 }]);
    vi.advanceTimersByTime(100);
    input.end();

    expect(actions).toEqual(["agentDown", "agentUp"]);
    vi.useRealTimers();
  });

  it("maps two stationary fingers to whisper push-to-talk", () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const input = new TouchButtonInput(
      {
        onAgentDown: () => actions.push("agentDown"),
        onAgentUp: () => actions.push("agentUp"),
        onWhisperDown: () => actions.push("whisperDown"),
        onWhisperUp: () => actions.push("whisperUp"),
        onActionEnter: () => actions.push("enter"),
        onActionEsc: () => actions.push("esc")
      },
      { stationaryMs: 100, movementPx: 10 }
    );

    input.start([
      { id: 1, x: 10, y: 10 },
      { id: 2, x: 20, y: 10 }
    ]);
    vi.advanceTimersByTime(100);
    input.end();

    expect(actions).toEqual(["whisperDown", "whisperUp"]);
    vi.useRealTimers();
  });

  it("maps three-finger tap and double tap to enter and escape", () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const input = new TouchButtonInput(
      {
        onAgentDown: () => actions.push("agentDown"),
        onAgentUp: () => actions.push("agentUp"),
        onWhisperDown: () => actions.push("whisperDown"),
        onWhisperUp: () => actions.push("whisperUp"),
        onActionEnter: () => actions.push("enter"),
        onActionEsc: () => actions.push("esc")
      },
      { stationaryMs: 100, movementPx: 10 }
    );

    input.start([
      { id: 1, x: 10, y: 10 },
      { id: 2, x: 20, y: 10 },
      { id: 3, x: 30, y: 10 }
    ]);
    input.end();
    vi.advanceTimersByTime(260);
    expect(actions).toEqual(["enter"]);

    input.start([
      { id: 1, x: 10, y: 10 },
      { id: 2, x: 20, y: 10 },
      { id: 3, x: 30, y: 10 }
    ]);
    input.end();
    input.start([
      { id: 1, x: 10, y: 10 },
      { id: 2, x: 20, y: 10 },
      { id: 3, x: 30, y: 10 }
    ]);
    input.end();
    vi.advanceTimersByTime(260);
    expect(actions).toEqual(["enter", "esc"]);
    vi.useRealTimers();
  });

  it("cancels button input when the touch moves like a swipe", () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const input = new TouchButtonInput(
      {
        onAgentDown: () => actions.push("agentDown"),
        onAgentUp: () => actions.push("agentUp"),
        onWhisperDown: () => actions.push("whisperDown"),
        onWhisperUp: () => actions.push("whisperUp"),
        onActionEnter: () => actions.push("enter"),
        onActionEsc: () => actions.push("esc")
      },
      { stationaryMs: 100, movementPx: 10 }
    );

    input.start([{ id: 1, x: 10, y: 10 }]);
    input.move([{ id: 1, x: 10, y: 40 }]);
    vi.advanceTimersByTime(120);
    input.end();

    expect(actions).toEqual([]);
    vi.useRealTimers();
  });
});
