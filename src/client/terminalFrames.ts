export function shouldRenderTerminalFrame(
  previousSequence: number | undefined,
  nextSequence: number
): boolean {
  return previousSequence === undefined || nextSequence >= previousSequence;
}

export function getLatestContentScrollLine(input: {
  bufferLength: number;
  rows: number;
  lineAt: (index: number) => string | undefined;
}): number {
  for (let index = input.bufferLength - 1; index >= 0; index -= 1) {
    if (input.lineAt(index)?.trim()) {
      return Math.max(0, index - input.rows + 1);
    }
  }

  return Math.max(0, input.bufferLength - input.rows);
}
