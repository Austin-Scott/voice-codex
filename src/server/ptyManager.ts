import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { SerializeAddon } from "@xterm/addon-serialize";
import headlessPkg from "@xterm/headless";
import type { Terminal as HeadlessTerminalInstance } from "@xterm/headless";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type {
  CodexThreadSummary,
  TerminalKeyToken,
  ThreadState
} from "../shared/protocol.js";
import { stripAnsi, tailLines } from "./ansi.js";
import type { AppConfig } from "./config.js";
import { encodeKeystrokes } from "./keystrokes.js";

const HeadlessTerminal = (headlessPkg as typeof import("@xterm/headless")).Terminal;

interface ManagedThread {
  id: string;
  name: string;
  cwd: string;
  state: ThreadState;
  process?: IPty;
  screen: HeadlessTerminalInstance;
  serializer: SerializeAddon;
  screenWriteQueue: Promise<void>;
  rawBuffer: string;
  plainBuffer: string;
  exitCode?: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TerminalDelta {
  threadId: string;
  data: string;
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

  async getSnapshot(id: string): Promise<{ raw: string; plain: string } | undefined> {
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    await thread.screenWriteQueue.catch(() => undefined);
    return {
      raw: thread.serializer.serialize(),
      plain: renderedPlainText(thread.screen)
    };
  }

  async readPlain(id: string, lines: number): Promise<string | undefined> {
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    await thread.screenWriteQueue.catch(() => undefined);
    return tailLines(renderedPlainText(thread.screen), lines);
  }

  create(input: { name?: string; cwd: string }): CodexThreadSummary {
    const id = randomUUID();
    const now = new Date();
    const screen = new HeadlessTerminal({ cols: 100, rows: 30, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer as unknown as Parameters<HeadlessTerminalInstance["loadAddon"]>[0]);
    const thread: ManagedThread = {
      id,
      name: input.name?.trim() || `Codex ${this.threads.size + 1}`,
      cwd: input.cwd,
      state: "starting",
      screen,
      serializer,
      screenWriteQueue: Promise.resolve(),
      rawBuffer: "",
      plainBuffer: "",
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
        this.emit("delta", { threadId: thread.id, data } satisfies TerminalDelta);
      });

      proc.onExit((event) => {
        thread.state = "exited";
        thread.exitCode = event.exitCode;
        thread.updatedAt = new Date();
        this.emit("thread", this.toSummary(thread));
      });
    } catch (error) {
      thread.state = "error";
      thread.error = error instanceof Error ? error.message : String(error);
      const errorOutput = `\r\nVoice Codex failed to start Codex CLI:\r\n${thread.error}\r\n`;
      this.append(thread, errorOutput);
      thread.updatedAt = new Date();
      this.emit("delta", { threadId: thread.id, data: errorOutput } satisfies TerminalDelta);
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
    const thread = this.threads.get(id);
    if (!thread) {
      return undefined;
    }

    thread.process?.kill();
    thread.state = "exited";
    thread.updatedAt = new Date();
    this.emit("thread", this.toSummary(thread));
    return this.toSummary(thread);
  }

  resize(id: string, cols: number, rows: number): boolean {
    const thread = this.threads.get(id);
    if (!thread?.process) {
      return false;
    }

    thread.process.resize(Math.max(20, cols), Math.max(5, rows));
    thread.screen.resize(Math.max(20, cols), Math.max(5, rows));
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
    return this.write(id, encodeKeystrokes(tokens));
  }

  private append(thread: ManagedThread, data: string): void {
    thread.screenWriteQueue = thread.screenWriteQueue
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            thread.screen.write(data, resolve);
          })
      );
    thread.rawBuffer = limitBuffer(thread.rawBuffer + data, this.config.scrollbackLimit);
    thread.plainBuffer = limitBuffer(stripAnsi(thread.rawBuffer), this.config.scrollbackLimit);
    thread.updatedAt = new Date();
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
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function limitBuffer(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(value.length - maxLength);
}

function renderedPlainText(screen: HeadlessTerminalInstance): string {
  const buffer = screen.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}
