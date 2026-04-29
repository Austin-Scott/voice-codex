import { describe, expect, it } from "vitest";
import { shouldRenderTerminalFrame } from "../src/client/terminalFrames";

describe("terminal frame sequencing", () => {
  it("accepts first, newer, and duplicate frames", () => {
    expect(shouldRenderTerminalFrame(undefined, 0)).toBe(true);
    expect(shouldRenderTerminalFrame(1, 2)).toBe(true);
    expect(shouldRenderTerminalFrame(2, 2)).toBe(true);
  });

  it("rejects stale frames", () => {
    expect(shouldRenderTerminalFrame(3, 2)).toBe(false);
  });
});
