import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type {
  CodexThreadSummary,
  TerminalFramePayload,
  TerminalKeyToken,
  ThreadState
} from "../shared/protocol.js";
import type { AppConfig } from "./config.js";
import { encodeKeystrokeToken, isSpecialKeyToken, normalizeKeystrokes } from "./keystrokes.js";
import { TerminalScreen } from "./terminalScreen.js";

const FRAME_INTERVAL_MS = 75;
const TEXT_CHUNK_DELAY_MS = 25;
const SPECIAL_KEY_DELAY_MS = 150;

interface ManagedThread {
  id: string;
  name: string;
  cwd: string;
  state: ThreadState;
  process?: IPty;
  terminal: TerminalScreen;
  inputQueue: Promise<void>;
  frameTimer?: NodeJS.Timeout;
  exitCode?: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class PtyThreadManager extends EventEmitter {
  private threads = new Map<string, ManagedThread>();
  private activeThreadId: string | undefined;

  constructor(private readonly config: AppConfig) {
    super();
  }

  list(): CodexThreadSummary[] {
    return Array.from(this.threads.values()).map((thread) => this.toSummary(thread));
  }

  getActiveThreadId(): string | undefined {
    return this.activeThreadId;
  }

  getSummary(id: string): CodexThreadSummary | undefined {
    const thread = this.threads.get(id);
    return thread ? this.toSummary(thread) : undefined;
  }

  async getSnapshot(id: string): Promise<TerminalFramePayload | undefined> {
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    return thread.terminal.snapshot(thread.id);
  }

  async readPlain(id: string, lines: number): Promise<string | undefined> {
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    return thread.terminal.readPlain(lines);
  }

  create(input: { name?: string; cwd: string }): CodexThreadSummary {
    const id = randomUUID();
    const now = new Date();
    const thread: ManagedThread = {
      id,
      name: input.name?.trim() || `Codex ${this.threads.size + 1}`,
      cwd: input.cwd,
      state: "starting",
      terminal: new TerminalScreen(100, 30),
      inputQueue: Promise.resolve(),
      createdAt: now,
      updatedAt: now
    };

    this.threads.set(id, thread);
    this.activeThreadId = id;
    this.emit("thread", this.toSummary(thread));

    try {
      const command = resolveShellCommand(this.config.codexBin, this.config.codexArgs);
      const proc = pty.spawn(command.file, command.args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: input.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      });

      thread.process = proc;
      thread.state = "running";
      thread.updatedAt = new Date();
      this.emit("thread", this.toSummary(thread));

      proc.onData((data) => {
        this.append(thread, data);
      });

      proc.onExit((event) => {
        thread.state = "exited";
        thread.exitCode = event.exitCode;
        thread.updatedAt = new Date();
        this.removeThread(thread);
      });
    } catch (error) {
      thread.state = "error";
      thread.error = error instanceof Error ? error.message : String(error);
      const errorOutput = `\r\nVoice Codex failed to start Codex CLI:\r\n${thread.error}\r\n`;
      this.append(thread, errorOutput);
      thread.updatedAt = new Date();
      this.emit("thread", this.toSummary(thread));
    }

    return this.toSummary(thread);
  }

  select(id: string): CodexThreadSummary | undefined {
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    this.activeThreadId = id;
    this.emit("threads", this.list());
    return this.toSummary(thread);
  }

  stop(id: string): CodexThreadSummary | undefined {
    return this.close(id);
  }

  close(id: string): CodexThreadSummary | undefined {
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    thread.state = "exited";
    thread.updatedAt = new Date();
    const summary = this.toSummary(thread);
    thread.process?.kill();
    this.removeThread(thread);
    return summary;
  }

  private removeThread(thread: ManagedThread): void {
    if (!this.threads.has(thread.id)) {
      return;
    }

    if (thread.frameTimer) {
      clearTimeout(thread.frameTimer);
      thread.frameTimer = undefined;
    }
    thread.process = undefined;
    this.threads.delete(thread.id);
    if (this.activeThreadId === thread.id) {
      this.activeThreadId = this.getMostRecentThreadId();
    }
    this.emit("thread.closed", thread.id);
    this.emit("threads", this.list());
  }

  resize(id: string, cols: number, rows: number): boolean {
    const thread = this.threads.get(id);
    if (!thread?.process) {
      return false;
    }

    thread.process.resize(Math.max(20, cols), Math.max(5, rows));
    thread.terminal.resize(cols, rows);
    this.scheduleFrame(thread);
    return true;
  }

  write(id: string, data: string): boolean {
    const thread = this.threads.get(id);
    if (!thread?.process || thread.state !== "running") {
      return false;
    }

    thread.process.write(data);
    return true;
  }

  writeKeystrokes(id: string, tokens: TerminalKeyToken[]): boolean {
    const thread = this.threads.get(id);
    if (!thread?.process || thread.state !== "running") {
      return false;
    }

    const chunks = normalizeKeystrokes(tokens)
      .map((token) => ({
        data: encodeKeystrokeToken(token),
        special: isSpecialKeyToken(token)
      }))
      .filter((chunk) => chunk.data.length > 0);
    thread.inputQueue = thread.inputQueue
      .catch(() => undefined)
      .then(() => writeChunks(thread, chunks));
    return true;
  }

  private append(thread: ManagedThread, data: string): void {
    thread.terminal
      .write(data)
      .then(() => {
        this.scheduleFrame(thread);
      })
      .catch((error: unknown) => {
        thread.error = error instanceof Error ? error.message : String(error);
        thread.state = "error";
        this.emit("thread", this.toSummary(thread));
      });
    thread.updatedAt = new Date();
  }

  private scheduleFrame(thread: ManagedThread): void {
    if (thread.frameTimer) {
      return;
    }

    thread.frameTimer = setTimeout(() => {
      thread.frameTimer = undefined;
      this.emitFrame(thread);
    }, FRAME_INTERVAL_MS);
  }

  private emitFrame(thread: ManagedThread): void {
    thread.terminal
      .nextFrame(thread.id)
      .then((frame) => {
        this.emit("frame", frame);
      })
      .catch((error: unknown) => {
        thread.error = error instanceof Error ? error.message : String(error);
        thread.state = "error";
        this.emit("thread", this.toSummary(thread));
      });
  }

  private toSummary(thread: ManagedThread): CodexThreadSummary {
    return {
      id: thread.id,
      name: thread.name,
      cwd: thread.cwd,
      state: thread.state,
      active: this.activeThreadId === thread.id,
      exitCode: thread.exitCode,
      error: thread.error,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString()
    };
  }

  private getMostRecentThreadId(): string | undefined {
    let selected: ManagedThread | undefined;
    for (const thread of this.threads.values()) {
      if (!selected || thread.updatedAt > selected.updatedAt) {
        selected = thread;
      }
    }
    return selected?.id;
  }
}

function resolveShellCommand(command: string, args: string[]): { file: string; args: string[] } {
  const shellCommand = [command, ...args.map(quoteShellPart)].join(" ");
  if (process.platform === "win32") {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", shellCommand] };
  }

  return { file: process.env.SHELL ?? "/bin/sh", args: ["-lc", shellCommand] };
}

function quoteShellPart(value: string): string {
  if (process.platform === "win32") {
    if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
      return value;
    }

    return `"${value.replace(/"/g, '""')}"`;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function writeChunks(
  thread: ManagedThread,
  chunks: Array<{ data: string; special: boolean }>
): Promise<void> {
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) {
      await delay(chunk.special ? SPECIAL_KEY_DELAY_MS : TEXT_CHUNK_DELAY_MS);
    }
    if (!thread.process || thread.state !== "running") {
      return;
    }
    thread.process.write(chunk.data);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
