import { describe, expect, it } from "vitest";
import { encodeKeystrokes, normalizeKeystrokes } from "../src/server/keystrokes";

describe("keystrokes", () => {
  it("encodes literal text and named keys", () => {
    expect(encodeKeystrokes(["hello", "<ENTER>", "<ESC>", "<CTRL_C>"])).toBe(
      "hello\r\u001b\u0003"
    );
  });

  it("normalizes arrays and strings", () => {
    expect(normalizeKeystrokes(["a", 1, "<ENTER>"])).toEqual(["a", "1", "<ENTER>"]);
    expect(normalizeKeystrokes("literal")).toEqual(["literal"]);
    expect(normalizeKeystrokes(null)).toEqual([]);
  });
});
