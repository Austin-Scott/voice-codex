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
    throw new Error(summarizeOpenAiError(response.status, responseText));
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
    output_modalities: ["audio"],
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
      "If the user says keep listening, call set_listening_mode with alwaysListening true. If the user says stop listening, call set_listening_mode with alwaysListening false.",
      "When the user asks you to act, read the active terminal first if useful, then call draft_keystrokes with the exact keys or text you want to send.",
      "When read_terminal returns aboveVisibleText, treat it as scrollback above the user's current viewport, not text currently visible on screen.",
      "If the user asks to scroll the terminal view, call scroll_terminal instead of sending arrow keys.",
      "You may create and switch Codex threads by browsing directories and creating a thread in the chosen directory.",
      "After drafting, briefly say what is waiting on screen and ask the user to approve or reject it.",
      "If the user asks to change pending keystrokes, call update_keystroke_proposal instead of creating a second proposal.",
      "If the user asks about pending approvals, or before you say no pending approvals exist, call list_pending_proposals.",
      "If the user verbally approves or rejects a visible proposal, call list_pending_proposals if you need the proposal id, then call resolve_keystroke_proposal.",
      "Use literal text tokens for normal typing. Use named tokens for special keys: <ENTER>, <ESC>, <TAB>, <SPACE>, <SHIFT_TAB>, <BACKSPACE>, <CTRL_A> through <CTRL_Z>, <UP>, <DOWN>, <LEFT>, <RIGHT>.",
      "When a proposal includes a special key, include that named token in both keystrokes and displayText, for example npm test<ENTER>.",
      "If the user asks to close or remove a Codex thread from the tab bar, call close_thread; do not draft /exit unless the user specifically asks to send /exit.",
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
        name: "list_pending_proposals",
        description:
          "List keystroke approval proposals currently visible in the controller UI, including proposal ids needed to approve, reject, or edit them.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "read_terminal",
        description:
          "Read plain-text terminal output for a managed Codex session. For the active controller thread, this returns the browser's currently visible viewport plus bounded scrollback above it, clearly marked as not currently visible.",
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
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "scroll_terminal",
        description:
          "Scroll the active controller terminal viewport and return the newly visible terminal context.",
        parameters: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down", "top", "bottom"],
              description: "Direction to scroll the browser terminal viewport."
            },
            lines: {
              type: "number",
              description:
                "Number of lines to scroll for up/down. Omit to scroll about one visible page."
            }
          },
          required: ["direction"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "set_listening_mode",
        description:
          "Turn continuous advanced voice listening on or off. When on, the microphone remains active without holding the push-to-talk button.",
        parameters: {
          type: "object",
          properties: {
            alwaysListening: {
              type: "boolean",
              description: "True to keep listening continuously, false to return to push-to-talk."
            }
          },
          required: ["alwaysListening"],
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
            threadId: {
              type: "string",
              description: "Target thread id. Omit to use the active terminal."
            },
            keystrokes: {
              type: "array",
              items: { type: "string" },
              description:
                "Literal text tokens and/or named tokens such as <ENTER>, <SPACE>, <SHIFT_TAB>, or <CTRL_U>."
            },
            displayText: {
              type: "string",
              description:
                "Preview of the exact terminal input. Use named tokens such as <ENTER> for special keys instead of prose."
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
        name: "update_keystroke_proposal",
        description:
          "Edit an existing pending keystroke proposal. Use this when the user asks to change what will be sent before approval.",
        parameters: {
          type: "object",
          properties: {
            proposalId: { type: "string" },
            keystrokes: {
              type: "array",
              items: { type: "string" },
              description:
                "Updated literal text tokens and/or named tokens such as <ENTER>, <SPACE>, <SHIFT_TAB>, or <CTRL_U>."
            },
            displayText: {
              type: "string",
              description:
                "Updated preview of the exact terminal input. Use named tokens such as <ENTER> for special keys instead of prose."
            },
            reason: { type: "string", description: "Optional updated reason." }
          },
          required: ["proposalId", "keystrokes", "displayText"],
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
        name: "close_thread",
        description:
          "Close a managed Codex terminal session and remove it from the controller tab bar. Omit threadId to close the active thread.",
        parameters: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Thread id to close. Omit to close the active thread." }
          },
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

function summarizeOpenAiError(status: number, body: string): string {
  try {
    const data = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = data.error?.message ?? data.message;
    if (message) {
      return `Realtime session failed with HTTP ${status}: ${message}`;
    }
  } catch {
    // Fall through to compact text handling.
  }

  const compact = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  return `Realtime session failed with HTTP ${status}${compact ? `: ${compact}` : ""}`;
}
