import { describe, expect, it } from "vitest";
import {
  encodeKeystrokes,
  normalizeKeystrokes,
  normalizeProposalKeystrokes
} from "../src/server/keystrokes";

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

  it("splits embedded named keys before encoding", () => {
    expect(normalizeKeystrokes("npm test<ENTER>")).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes("npm test<enter>")).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes("npm test[Enter]")).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes("npm test{return}")).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes("npm test\n")).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes("npm test\\n")).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes(["npm test", "Enter"])).toEqual(["npm test", "<ENTER>"]);
    expect(normalizeKeystrokes(["npm test", "press enter key"])).toEqual([
      "npm test",
      "<ENTER>"
    ]);
    expect(normalizeKeystrokes(["a<TAB>b", "<CTRL_C>"])).toEqual([
      "a",
      "<TAB>",
      "b",
      "<CTRL_C>"
    ]);
    expect(encodeKeystrokes(["npm test<ENTER>"])).toBe("npm test\r");
  });

  it("uses display text special keys when tool keystrokes omit them", () => {
    expect(normalizeProposalKeystrokes(["npm test"], "npm test<ENTER>")).toEqual([
      "npm test",
      "<ENTER>"
    ]);
    expect(normalizeProposalKeystrokes(["npm test", "<ENTER>"], "npm test")).toEqual([
      "npm test",
      "<ENTER>"
    ]);
  });
});
