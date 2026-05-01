import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { CodexThreadSummary, TurnSummary } from "../shared/protocol.js";

const MAX_SUMMARIES = 80;

export class TurnSummaryManager extends EventEmitter {
  private summaries: TurnSummary[] = [];

  create(input: {
    thread: Pick<CodexThreadSummary, "id" | "name">;
    summary: string;
    status?: string;
  }): TurnSummary {
    const summaryText = input.summary.trim();
    if (!summaryText) {
      throw new Error("Summary is required");
    }

    const summary: TurnSummary = {
      id: randomUUID(),
      threadId: input.thread.id,
      threadName: input.thread.name,
      summary: summaryText.slice(0, 4000),
      status: input.status?.trim().slice(0, 80) || undefined,
      createdAt: new Date().toISOString()
    };

    this.summaries.unshift(summary);
    if (this.summaries.length > MAX_SUMMARIES) {
      this.summaries.length = MAX_SUMMARIES;
    }

    this.emit("created", summary);
    return summary;
  }

  list(threadId?: string): TurnSummary[] {
    return threadId
      ? this.summaries.filter((summary) => summary.threadId === threadId)
      : [...this.summaries];
  }

  latest(threadId?: string): TurnSummary | undefined {
    return this.list(threadId)[0];
  }
}
