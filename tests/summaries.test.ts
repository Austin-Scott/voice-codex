import { describe, expect, it } from "vitest";
import { TurnSummaryManager } from "../src/server/summaries";

describe("TurnSummaryManager", () => {
  it("stores newest summaries first and supports thread filtering", () => {
    const manager = new TurnSummaryManager();
    const first = manager.create({
      thread: { id: "thread-1", name: "Thread 1" },
      summary: " first summary ",
      status: "done"
    });
    const second = manager.create({
      thread: { id: "thread-2", name: "Thread 2" },
      summary: "second summary"
    });

    expect(manager.list().map((summary) => summary.id)).toEqual([second.id, first.id]);
    expect(manager.list("thread-1")).toEqual([first]);
    expect(manager.latest("thread-2")).toBe(second);
    expect(first.summary).toBe("first summary");
  });

  it("rejects blank summaries", () => {
    const manager = new TurnSummaryManager();

    expect(() =>
      manager.create({
        thread: { id: "thread-1", name: "Thread 1" },
        summary: "   "
      })
    ).toThrow("Summary is required");
  });
});
