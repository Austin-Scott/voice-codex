import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../src/server/terminalScreen";

describe("TerminalScreen", () => {
  it("renders cursor overwrite output as the current screen state", async () => {
    const screen = new TerminalScreen(20, 5);

    await screen.write("hello");
    await screen.write("\rfinal");
    const frame = await screen.snapshot("thread-1");

    expect(frame.plainText).toBe("final");
    expect(frame.data).toContain("final");
    expect(frame.data).not.toContain("hello");
  });

  it("increments frame sequences only for emitted frames", async () => {
    const screen = new TerminalScreen(20, 5);

    await screen.write("first");
    const snapshot = await screen.snapshot("thread-1");
    const firstFrame = await screen.nextFrame("thread-1");
    const secondFrame = await screen.nextFrame("thread-1");

    expect(snapshot.sequence).toBe(0);
    expect(firstFrame.sequence).toBe(1);
    expect(secondFrame.sequence).toBe(2);
  });

  it("includes bounded scrollback in serialized frames", async () => {
    const screen = new TerminalScreen(20, 3, 4);

    for (let index = 0; index < 7; index += 1) {
      await screen.write(`line-${index}\r\n`);
    }
    const frame = await screen.snapshot("thread-1");

    expect(frame.data).toContain("line-2");
    expect(frame.data).toContain("line-6");
    expect(frame.data).not.toContain("line-0");
  });
});
