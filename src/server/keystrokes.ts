import type { TerminalKeyToken } from "../shared/protocol.js";

const KEY_MAP: Record<string, string> = {
  "<ENTER>": "\r",
  "<ESC>": "\u001b",
  "<TAB>": "\t",
  "<BACKSPACE>": "\u007f",
  "<CTRL_C>": "\u0003",
  "<UP>": "\u001b[A",
  "<DOWN>": "\u001b[B",
  "<RIGHT>": "\u001b[C",
  "<LEFT>": "\u001b[D"
};

export function encodeKeystrokes(tokens: TerminalKeyToken[]): string {
  return tokens.map((token) => KEY_MAP[token] ?? token).join("");
}

export function normalizeKeystrokes(value: unknown): TerminalKeyToken[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
}
