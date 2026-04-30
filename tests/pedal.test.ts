import { describe, expect, it, vi } from "vitest";
import { TapDoubleHoldGesture } from "../src/client/pedal";

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
