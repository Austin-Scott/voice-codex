export function shouldRenderTerminalFrame(
  previousSequence: number | undefined,
  nextSequence: number
): boolean {
  return previousSequence === undefined || nextSequence >= previousSequence;
}
