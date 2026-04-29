import fs from "node:fs/promises";
import type { AppConfig } from "./config.js";

export async function readOpenAiApiKey(config: AppConfig): Promise<string> {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return process.env.OPENAI_API_KEY.trim();
  }

  try {
    return (await fs.readFile(config.apiKeyPath, "utf8")).trim();
  } catch {
    throw new Error(`OpenAI API key not found. Create ${config.apiKeyPath}.`);
  }
}

export async function createRealtimeAnswer(config: AppConfig, offerSdp: string): Promise<string> {
  const apiKey = await readOpenAiApiKey(config);
  const body = new FormData();
  body.set("sdp", offerSdp);
  body.set("session", JSON.stringify(createRealtimeSessionConfig(config)));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `Realtime session failed with HTTP ${response.status}`);
  }

  return responseText;
}

export async function transcribeAudio(
  config: AppConfig,
  audio: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const apiKey = await readOpenAiApiKey(config);
  const body = new FormData();
  const audioBytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  body.set("model", config.transcriptionModel);
  body.set("file", new Blob([audioBytes], { type: mimeType || "audio/webm" }), filename || "speech.webm");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body
  });

  const data = (await response.json()) as { text?: string; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Transcription failed with HTTP ${response.status}`);
  }

  return data.text ?? "";
}

function createRealtimeSessionConfig(config: AppConfig): object {
  return {
    type: "realtime",
    model: config.realtimeModel,
    output_modalities: ["audio", "text"],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad"
        }
      },
      output: {
        voice: config.realtimeVoice
      }
    },
    instructions: [
      "You are Voice Codex, a voice agent that helps control Codex CLI terminals.",
      "You can inspect terminal output through tools and draft keystrokes, but you must not send terminal input directly.",
      "When the user asks you to act, read the active terminal first if useful, then call draft_keystrokes with the exact keys or text you want to send.",
      "You may create and switch Codex threads by browsing directories and creating a thread in the chosen directory.",
      "After drafting, briefly say what is waiting on screen and ask the user to approve or reject it.",
      "If the user verbally approves or rejects a visible proposal, call resolve_keystroke_proposal.",
      "Use literal text tokens for normal typing. Use named tokens for special keys: <ENTER>, <ESC>, <TAB>, <BACKSPACE>, <CTRL_C>, <UP>, <DOWN>, <LEFT>, <RIGHT>.",
      "Keep spoken responses short."
    ].join("\n"),
    tools: [
      {
        type: "function",
        name: "list_threads",
        description: "List managed Codex terminal sessions and identify the active one.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "read_terminal",
        description: "Read recent plain-text terminal output for a managed Codex session.",
        parameters: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Thread id to read." },
            lines: {
              type: "number",
              description: "Number of recent terminal lines to return.",
              default: 80
            }
          },
          required: ["threadId"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "draft_keystrokes",
        description:
          "Create an on-screen proposal for keystrokes to send to a Codex terminal. This does not send anything until approved.",
        parameters: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            keystrokes: {
              type: "array",
              items: { type: "string" },
              description:
                "Literal text tokens and/or named tokens such as <ENTER>, <ESC>, <TAB>, <CTRL_C>."
            },
            displayText: {
              type: "string",
              description: "Human-readable version of the exact terminal input."
            },
            reason: { type: "string", description: "Why these keystrokes are being proposed." }
          },
          required: ["threadId", "keystrokes", "displayText", "reason"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "resolve_keystroke_proposal",
        description: "Approve or reject an existing keystroke proposal after the user says so.",
        parameters: {
          type: "object",
          properties: {
            proposalId: { type: "string" },
            decision: { type: "string", enum: ["approve", "reject"] }
          },
          required: ["proposalId", "decision"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "select_thread",
        description: "Select the active Codex terminal session.",
        parameters: {
          type: "object",
          properties: {
            threadId: { type: "string" }
          },
          required: ["threadId"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "browse_directories",
        description: "Browse directories under the server's configured Codex workspace root.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path to list. Omit or send an empty string for the root."
            }
          },
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "create_directory",
        description: "Create a new child directory under the configured workspace root.",
        parameters: {
          type: "object",
          properties: {
            parentPath: { type: "string" },
            name: { type: "string" }
          },
          required: ["parentPath", "name"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "create_thread",
        description: "Create and select a Codex thread in an existing directory under the workspace root.",
        parameters: {
          type: "object",
          properties: {
            cwd: { type: "string" },
            name: {
              type: "string",
              description: "Optional thread name. If omitted, the server names it from the directory."
            }
          },
          required: ["cwd"],
          additionalProperties: false
        }
      }
    ],
    tool_choice: "auto"
  };
}
