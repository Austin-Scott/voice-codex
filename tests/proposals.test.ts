import { describe, expect, it, vi } from "vitest";
import { ProposalManager } from "../src/server/proposals";

describe("ProposalManager", () => {
  it("deduplicates identical pending proposals", () => {
    const threads = {
      getSummary: vi.fn(() => ({
        id: "thread-1",
        name: "Thread 1"
      })),
      writeKeystrokes: vi.fn(() => true)
    };
    const manager = new ProposalManager(threads as never);

    const first = manager.create({
      threadId: "thread-1",
      keystrokes: ["hello", "<ENTER>"],
      displayText: "hello",
      reason: "test"
    });
    const second = manager.create({
      threadId: "thread-1",
      keystrokes: ["hello", "<ENTER>"],
      displayText: "hello",
      reason: "test"
    });

    expect(second.id).toBe(first.id);
    expect(manager.listPending()).toHaveLength(1);
  });

  it("removes approved proposals from the pending list", () => {
    const threads = {
      getSummary: vi.fn(() => ({
        id: "thread-1",
        name: "Thread 1"
      })),
      writeKeystrokes: vi.fn(() => true)
    };
    const manager = new ProposalManager(threads as never);
    const proposal = manager.create({
      threadId: "thread-1",
      keystrokes: ["hello"],
      displayText: "hello",
      reason: "test"
    });

    manager.resolve(proposal.id, "approve");

    expect(manager.listPending()).toEqual([]);
    expect(threads.writeKeystrokes).toHaveBeenCalledWith("thread-1", ["hello"]);
  });
});
