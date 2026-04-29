const ANSI_PATTERN = /(?:\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\))/g;

export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+$/g, ""))
    .join("\n");
}

export function tailLines(input: string, lines: number): string {
  if (lines <= 0) {
    return "";
  }

  const allLines = input.split("\n");
  return allLines.slice(Math.max(0, allLines.length - lines)).join("\n");
}
