import type { TerminalKeyToken } from "../shared/protocol.js";

const STATIC_KEY_MAP: Record<string, string> = {
  ENTER: "\r",
  ESC: "\u001b",
  TAB: "\t",
  SPACE: " ",
  SHIFT_TAB: "\u001b[Z",
  BACKSPACE: "\u007f",
  UP: "\u001b[A",
  DOWN: "\u001b[B",
  RIGHT: "\u001b[C",
  LEFT: "\u001b[D",
  DELETE: "\u001b[3~",
  HOME: "\u001b[H",
  END: "\u001b[F",
  PAGE_UP: "\u001b[5~",
  PAGE_DOWN: "\u001b[6~"
};
const KEY_TOKEN_PATTERN =
  /(<[^<>\r\n]+>|\[[A-Za-z0-9\s+_-]+\]|\{[A-Za-z0-9\s+_-]+\}|\\r\\n|\\r|\\n|\r\n|\r|\n)/g;

export function encodeKeystrokes(tokens: TerminalKeyToken[]): string {
  return tokens.flatMap(splitKeyTokens).map(encodeKeystrokeToken).join("");
}

export function encodeKeystrokeToken(token: TerminalKeyToken): string {
  return encodeSpecialKeyToken(token) ?? token;
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
  return encodeSpecialKeyToken(token) !== undefined;
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
    return canonicalizeBareKey(value) ?? value;
  }

  return token[1] ? canonicalizeBareKey(token[1]) ?? value : value;
}

function canonicalizeBareKey(value: string): TerminalKeyToken | undefined {
  const keyName = normalizeKeyName(value);
  return keyName ? `<${keyName}>` : undefined;
}

function encodeSpecialKeyToken(value: string): string | undefined {
  const keyName = normalizeKeyName(stripTokenWrapper(value) ?? value);
  if (!keyName) {
    return undefined;
  }

  const staticValue = STATIC_KEY_MAP[keyName];
  if (staticValue !== undefined) {
    return staticValue;
  }

  const control = keyName.match(/^CTRL_([A-Z])$/);
  if (control?.[1]) {
    return String.fromCharCode(control[1].charCodeAt(0) - 64);
  }

  return undefined;
}

function normalizeKeyName(value: string): string | undefined {
  const stripped = value
    .trim()
    .replace(/\bplus\b/gi, "+")
    .replace(/\s*\+\s*/g, "+")
    .replace(/^(?:press|hit|send)\s+(?:the\s+)?/i, "")
    .replace(/\s+key$/i, "");
  if (!stripped) {
    return undefined;
  }

  const name = stripped.toUpperCase().replace(/[\s+_-]+/g, "_");
  if (name === "RETURN") {
    return "ENTER";
  }
  if (name === "ESCAPE") {
    return "ESC";
  }
  if (name === "SHIFTTAB") {
    return "SHIFT_TAB";
  }
  if (name === "SPACEBAR" || name === "SPACE_BAR") {
    return "SPACE";
  }
  if (name === "PGUP") {
    return "PAGE_UP";
  }
  if (name === "PGDN") {
    return "PAGE_DOWN";
  }

  const arrow = name.match(/^(UP|DOWN|LEFT|RIGHT)_?ARROW$/);
  if (arrow?.[1]) {
    return arrow[1];
  }

  const control = name.match(/^(?:CTRL|CONTROL)_?([A-Z])$/);
  if (control?.[1]) {
    return `CTRL_${control[1]}`;
  }

  if (Object.prototype.hasOwnProperty.call(STATIC_KEY_MAP, name)) {
    return name;
  }

  return undefined;
}

function stripTokenWrapper(value: string): string | undefined {
  return value.match(/^[<[{](.+)[>\]}]$/)?.[1];
}
