import { describe, expect, it } from "vitest";
import {
  getLatestContentScrollLine,
  shouldRenderTerminalFrame
} from "../src/client/terminalFrames";

describe("terminal frame sequencing", () => {
  it("accepts first, newer, and duplicate frames", () => {
    expect(shouldRenderTerminalFrame(undefined, 0)).toBe(true);
    expect(shouldRenderTerminalFrame(1, 2)).toBe(true);
    expect(shouldRenderTerminalFrame(2, 2)).toBe(true);
  });

  it("rejects stale frames", () => {
    expect(shouldRenderTerminalFrame(3, 2)).toBe(false);
  });

  it("anchors to the last non-empty line instead of trailing blank rows", () => {
    const lines = ["older", "current", "", "", ""];

    expect(
      getLatestContentScrollLine({
        bufferLength: lines.length,
        rows: 3,
        lineAt: (index) => lines[index]
      })
    ).toBe(0);
  });

  it("falls back to the physical bottom for all-blank buffers", () => {
    expect(
      getLatestContentScrollLine({
        bufferLength: 10,
        rows: 4,
        lineAt: () => ""
      })
    ).toBe(6);
  });
});
