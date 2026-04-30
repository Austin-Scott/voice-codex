import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { KeystrokeProposal, TerminalKeyToken } from "../shared/protocol.js";
import type { PtyThreadManager } from "./ptyManager.js";

export class ProposalManager extends EventEmitter {
  private proposals = new Map<string, KeystrokeProposal>();

  constructor(private readonly threads: PtyThreadManager) {
    super();
  }

  create(input: {
    threadId: string;
    keystrokes: TerminalKeyToken[];
    displayText: string;
    reason: string;
  }): KeystrokeProposal {
    const thread = this.threads.getSummary(input.threadId);
    if (!thread) {
      throw new Error("Unknown thread");
    }

    const existing = Array.from(this.proposals.values()).find(
      (proposal) =>
        proposal.status === "pending" &&
        proposal.threadId === input.threadId &&
        proposal.displayText === input.displayText &&
        proposal.reason === input.reason &&
        JSON.stringify(proposal.keystrokes) === JSON.stringify(input.keystrokes)
    );
    if (existing) {
      return existing;
    }

    const proposal: KeystrokeProposal = {
      id: randomUUID(),
      threadId: input.threadId,
      threadName: thread.name,
      keystrokes: input.keystrokes,
      displayText: input.displayText,
      reason: input.reason,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    this.proposals.set(proposal.id, proposal);
    this.emit("created", proposal);
    return proposal;
  }

  resolve(id: string, decision: "approve" | "reject"): KeystrokeProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error("Unknown proposal");
    }

    if (proposal.status !== "pending") {
      return proposal;
    }

    proposal.status = decision === "approve" ? "approved" : "rejected";
    proposal.resolvedAt = new Date().toISOString();

    if (proposal.status === "approved") {
      const sent = this.threads.writeKeystrokes(proposal.threadId, proposal.keystrokes);
      if (!sent) {
        proposal.status = "rejected";
        proposal.reason = `${proposal.reason}\n\nNot sent: target thread is not running.`;
      }
    }

    this.emit("resolved", proposal);
    return proposal;
  }

  update(
    id: string,
    input: {
      keystrokes: TerminalKeyToken[];
      displayText: string;
      reason?: string;
    }
  ): KeystrokeProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error("Unknown proposal");
    }

    if (proposal.status !== "pending") {
      throw new Error("Cannot edit a resolved proposal");
    }

    proposal.keystrokes = input.keystrokes;
    proposal.displayText = input.displayText;
    if (input.reason?.trim()) {
      proposal.reason = input.reason;
    }

    this.emit("updated", proposal);
    return proposal;
  }

  listPending(): KeystrokeProposal[] {
    return Array.from(this.proposals.values()).filter((proposal) => proposal.status === "pending");
  }

  rejectForThread(threadId: string, reason: string): void {
    for (const proposal of this.proposals.values()) {
      if (proposal.threadId !== threadId || proposal.status !== "pending") {
        continue;
      }

      proposal.status = "rejected";
      proposal.resolvedAt = new Date().toISOString();
      proposal.reason = `${proposal.reason}\n\n${reason}`;
      this.emit("resolved", proposal);
    }
  }
}
