import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerImageManager } from "../src/server/controllerImages";
import type { AppConfig } from "../src/server/config";
import { VoiceCodexMcpBridge } from "../src/server/mcpBridge";
import type { PtyThreadManager } from "../src/server/ptyManager";
import { TurnSummaryManager } from "../src/server/summaries";

const root = path.join(process.cwd(), "runtime", "mcp-bridge-test");
let bridge: VoiceCodexMcpBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

describe("VoiceCodexMcpBridge", () => {
  it("rejects invalid thread credentials", async () => {
    const config = createConfig();
    const threads = mockThreads();
    bridge = new VoiceCodexMcpBridge(
      config,
      threads as unknown as PtyThreadManager,
      new TurnSummaryManager(),
      new ControllerImageManager(config)
    );
    await bridge.listen();

    const response = await fetch(bridge.urlForThread("thread-1", "wrong"), {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(initializeRequest())
    });

    expect(response.status).toBe(401);
  });

  it("handles report_turn_summary tool calls for the authenticated thread", async () => {
    const config = createConfig();
    const summaries = new TurnSummaryManager();
    bridge = new VoiceCodexMcpBridge(
      config,
      mockThreads() as unknown as PtyThreadManager,
      summaries,
      new ControllerImageManager(config)
    );
    await bridge.listen();
    const url = bridge.urlForThread("thread-1", "secret");

    const init = await fetch(url, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(initializeRequest())
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(init.status).toBe(200);
    expect(sessionId).toBeTruthy();

    const call = await fetch(url, {
      method: "POST",
      headers: mcpHeaders(sessionId ?? undefined),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "report_turn_summary",
          arguments: {
            summary: "Implemented the requested change.",
            status: "completed"
          }
        }
      })
    });

    expect(call.status).toBe(200);
    expect(summaries.latest("thread-1")?.summary).toBe("Implemented the requested change.");
    expect(summaries.latest("thread-1")?.status).toBe("completed");
  });
});

function mockThreads(): Pick<PtyThreadManager, "getMcpThreadContext"> {
  return {
    getMcpThreadContext: vi.fn((threadId: string, token: string) =>
      threadId === "thread-1" && token === "secret"
        ? {
            id: "thread-1",
            name: "Thread 1",
            cwd: root
          }
        : undefined
    )
  };
}

function mcpHeaders(sessionId?: string): HeadersInit {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-11-25",
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
  };
}

function initializeRequest(): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "voice-codex-test",
        version: "0.1.0"
      }
    }
  };
}

function createConfig(): AppConfig {
  return {
    rootDir: process.cwd(),
    host: "127.0.0.1",
    port: 3000,
    codexBin: "codex",
    codexArgs: [],
    apiKeyPath: "",
    certDir: "",
    certPath: "",
    keyPath: "",
    realtimeModel: "gpt-realtime",
    realtimeVoice: "marin",
    transcriptionModel: "gpt-4o-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "marin",
    scrollbackLimit: 200000,
    workspaceRoot: root,
    mcpHost: "127.0.0.1",
    mcpPort: 0
  };
}
