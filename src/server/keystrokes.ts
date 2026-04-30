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
const KEY_TOKEN_PATTERN =
  /(<(?:ENTER|RETURN|ESCAPE|ESC|TAB|BACKSPACE|CTRL[_ -]?C|UP|DOWN|LEFT|RIGHT)>|\[(?:ENTER|RETURN|ESCAPE|ESC|TAB|BACKSPACE|CTRL[_ -]?C|UP|DOWN|LEFT|RIGHT)\]|\{(?:ENTER|RETURN|ESCAPE|ESC|TAB|BACKSPACE|CTRL[_ -]?C|UP|DOWN|LEFT|RIGHT)\}|\\r\\n|\\r|\\n|\r\n|\r|\n)/gi;
const BARE_KEY_PATTERN =
  /^(?:(?:PRESS|HIT|SEND)\s+)?(?:THE\s+)?(ENTER|RETURN|ESCAPE|ESC|TAB|BACKSPACE|CTRL[_ -]?C|UP|DOWN|LEFT|RIGHT)(?:\s+KEY)?$/i;

export function encodeKeystrokes(tokens: TerminalKeyToken[]): string {
  return tokens.flatMap(splitKeyTokens).map(encodeKeystrokeToken).join("");
}

export function encodeKeystrokeToken(token: TerminalKeyToken): string {
  return KEY_MAP[token] ?? token;
}

export function normalizeKeystrokes(value: unknown): TerminalKeyToken[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeKeystrokeString(String(item)));
  }

  if (typeof value === "string" && value.length > 0) {
    return normalizeKeystrokeString(value);
  }

  return [];
}

export function normalizeProposalKeystrokes(
  value: unknown,
  displayText: string
): TerminalKeyToken[] {
  const explicitTokens = normalizeKeystrokes(value);
  const displayTokens = normalizeKeystrokes(displayText);
  if (displayTokens.some(isSpecialKeyToken) && !explicitTokens.some(isSpecialKeyToken)) {
    return displayTokens;
  }

  return explicitTokens;
}

export function isSpecialKeyToken(token: TerminalKeyToken): boolean {
  return Object.prototype.hasOwnProperty.call(KEY_MAP, token);
}

function splitKeyTokens(value: string): TerminalKeyToken[] {
  return value
    .split(KEY_TOKEN_PATTERN)
    .filter((part) => part.length > 0)
    .map(canonicalizeKeyToken);
}

function normalizeKeystrokeString(value: string): TerminalKeyToken[] {
  const bareKey = canonicalizeBareKey(value);
  return bareKey ? [bareKey] : splitKeyTokens(value);
}

function canonicalizeKeyToken(value: string): TerminalKeyToken {
  const lowerValue = value.toLowerCase();
  if (
    value === "\r" ||
    value === "\n" ||
    value === "\r\n" ||
    lowerValue === "\\r" ||
    lowerValue === "\\n" ||
    lowerValue === "\\r\\n"
  ) {
    return "<ENTER>";
  }

  const token = value.match(/^[<[{](.+)[>\]}]$/);
  if (!token) {
    return value;
  }

  return canonicalizeBareKey(token[1]) ?? value;
}

function canonicalizeBareKey(value: string): TerminalKeyToken | undefined {
  const match = value.trim().match(BARE_KEY_PATTERN);
  if (!match) {
    return undefined;
  }

  const name = match[1].toUpperCase().replace(/[\s-]/g, "_");
  if (name === "RETURN") {
    return "<ENTER>";
  }
  if (name === "ESCAPE") {
    return "<ESC>";
  }
  return `<${name === "CTRL_C" ? "CTRL_C" : name}>`;
}
