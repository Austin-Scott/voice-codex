import { SerializeAddon } from "@xterm/addon-serialize";
import headlessPkg from "@xterm/headless";
import type { Terminal as HeadlessTerminalInstance } from "@xterm/headless";
import type { TerminalFramePayload } from "../shared/protocol.js";
import { tailLines } from "./ansi.js";

const HeadlessTerminal = (headlessPkg as typeof import("@xterm/headless")).Terminal;

export class TerminalScreen {
  private readonly screen: HeadlessTerminalInstance;
  private readonly serializer: SerializeAddon;
  private writeQueue: Promise<void> = Promise.resolve();
  private sequence = 0;

  constructor(cols: number, rows: number) {
    this.screen = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true
    });
    this.serializer = new SerializeAddon();
    this.screen.loadAddon(
      this.serializer as unknown as Parameters<HeadlessTerminalInstance["loadAddon"]>[0]
    );
  }

  get cols(): number {
    return this.screen.cols;
  }

  get rows(): number {
    return this.screen.rows;
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(Math.max(20, cols), Math.max(5, rows));
  }

  write(data: string): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            this.screen.write(data, resolve);
          })
      );
    return this.writeQueue;
  }

  async snapshot(threadId: string): Promise<TerminalFramePayload> {
    await this.writeQueue.catch(() => undefined);
    return this.toFrame(threadId, this.sequence);
  }

  async nextFrame(threadId: string): Promise<TerminalFramePayload> {
    await this.writeQueue.catch(() => undefined);
    this.sequence += 1;
    return this.toFrame(threadId, this.sequence);
  }

  async readPlain(lines: number): Promise<string> {
    await this.writeQueue.catch(() => undefined);
    return tailLines(this.renderPlainText(), lines);
  }

  private toFrame(threadId: string, sequence: number): TerminalFramePayload {
    return {
      threadId,
      sequence,
      cols: this.screen.cols,
      rows: this.screen.rows,
      data: this.serializer.serialize({ scrollback: 0 }),
      plainText: this.renderPlainText()
    };
  }

  private renderPlainText(): string {
    const buffer = this.screen.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  }
}
