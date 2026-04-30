import { describe, expect, it } from "vitest";
import {
  encodeKeystrokes,
  normalizeKeystrokes,
  normalizeProposalKeystrokes
} from "../src/server/keystrokes";

describe("keystrokes", () => {
  it("encodes literal text and named keys", () => {
    expect(
      encodeKeystrokes([
        "hello",
        "<ENTER>",
        "<ESC>",
        "<CTRL_C>",
        "<CTRL_J>",
        "<CTRL_U>",
        "<SHIFT_TAB>"
      ])
    ).toBe("hello\r\u001b\u0003\n\u0015\u001b[Z");
    expect(
      encodeKeystrokes(["<DELETE>", "<HOME>", "<END>", "<PAGE_UP>", "<PAGE_DOWN>"])
    ).toBe(
      "\u001b[3~\u001b[H\u001b[F\u001b[5~\u001b[6~"
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
    expect(normalizeKeystrokes(["send ctrl+j key", "<SHIFT+TAB>"])).toEqual([
      "<CTRL_J>",
      "<SHIFT_TAB>"
    ]);
    expect(normalizeKeystrokes(["<CTRL + U>", "shift + tab", "up arrow key"])).toEqual([
      "<CTRL_U>",
      "<SHIFT_TAB>",
      "<UP>"
    ]);
    expect(normalizeKeystrokes("Ctrl+U<ENTER>")).toEqual([
      "<CTRL_U>",
      "<ENTER>"
    ]);
    expect(normalizeKeystrokes(["control a", "control z"])).toEqual([
      "<CTRL_A>",
      "<CTRL_Z>"
    ]);
    expect(normalizeKeystrokes(["<CTRL_J>", "<CTRL_U>", "{page down}"])).toEqual([
      "<CTRL_J>",
      "<CTRL_U>",
      "<PAGE_DOWN>"
    ]);
    expect(normalizeKeystrokes(["<CTRL + J>", "shift + tab"])).toEqual([
      "<CTRL_J>",
      "<SHIFT_TAB>"
    ]);
    expect(normalizeKeystrokes(["a<TAB>b", "<CTRL_C>", "[Shift Tab]"])).toEqual([
      "a",
      "<TAB>",
      "b",
      "<CTRL_C>",
      "<SHIFT_TAB>"
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
