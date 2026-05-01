import { describe, expect, it } from "vitest";
import { resolveShellCommand, withVoiceCodexMcpArgs } from "../src/server/ptyManager";

const expectedMcpConfig =
  "mcp_servers.voice_codex={url='http://127.0.0.1:1234/mcp/thread-1?token=secret',enabled=true,tool_timeout_sec=15,default_tools_approval_mode='approve'}";

describe("withVoiceCodexMcpArgs", () => {
  it("appends voice-codex MCP config after existing args", () => {
    const args = withVoiceCodexMcpArgs(
      ["--sandbox", "workspace-write"],
      "http://127.0.0.1:1234/mcp/thread-1?token=secret"
    );

    expect(args).toEqual([
      "--sandbox",
      "workspace-write",
      "-c",
      "experimental_use_rmcp_client=true",
      "-c",
      "rmcp_client=true",
      "-c",
      expectedMcpConfig
    ]);
  });

  it("appends a whole server override so stale per-field config is replaced by Codex", () => {
    const args = withVoiceCodexMcpArgs(
      ["-c", 'mcp_servers.voice_codex.command="bad"'],
      "http://127.0.0.1:1234/mcp/thread-1?token=secret"
    );

    expect(args).toEqual([
      "-c",
      'mcp_servers.voice_codex.command="bad"',
      "-c",
      "experimental_use_rmcp_client=true",
      "-c",
      "rmcp_client=true",
      "-c",
      expectedMcpConfig
    ]);
  });

  it("keeps the generated inline table unquoted when launched through cmd.exe", () => {
    const args = withVoiceCodexMcpArgs(
      [],
      "http://127.0.0.1:1234/mcp/thread-1?token=secret"
    );

    const command = resolveShellCommand("codex", args);

    if (process.platform === "win32") {
      expect(command.args).toEqual([
        "/d",
        "/c",
        `codex -c experimental_use_rmcp_client=true -c rmcp_client=true -c ${expectedMcpConfig}`
      ]);
    } else {
      expect(command.args.join(" ")).toContain(
        "mcp_servers.voice_codex={url='\"'\"'http://127.0.0.1:1234/mcp/thread-1?token=secret'\"'\"',enabled=true,tool_timeout_sec=15,default_tools_approval_mode='\"'\"'approve'\"'\"'}"
      );
    }
  });
});
