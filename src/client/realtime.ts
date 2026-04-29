import type { CodexThreadSummary } from "@shared/protocol";
import {
  browseDirectories,
  createDirectory,
  createProposal,
  createRealtimeAnswer,
  createThread,
  readTerminal,
  resolveProposal,
  selectThread
} from "./api";

interface RealtimeEvent {
  type: string;
  item?: RealtimeFunctionCall;
  response?: {
    output?: RealtimeFunctionCall[];
  };
}

interface RealtimeFunctionCall {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

export interface RealtimeToolsState {
  getThreads: () => { threads: CodexThreadSummary[]; activeThreadId?: string };
  setActiveThread: (threadId: string) => void;
}

export class RealtimeVoiceAgent {
  private pc: RTCPeerConnection | undefined;
  private dc: RTCDataChannel | undefined;
  private micTrack: MediaStreamTrack | undefined;
  private connected = false;

  constructor(
    private readonly toolsState: RealtimeToolsState,
    private readonly onStatus: (status: string) => void,
    private readonly onError: (message: string) => void
  ) {}

  async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.onStatus("Connecting voice agent");
    const pc = new RTCPeerConnection();
    this.pc = pc;

    const remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micTrack = stream.getAudioTracks()[0];
    this.micTrack.enabled = false;
    pc.addTrack(this.micTrack, stream);

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("open", () => {
      this.connected = true;
      this.onStatus("Voice agent ready");
    });
    dc.addEventListener("message", (message) => this.handleMessage(message.data));
    dc.addEventListener("close", () => {
      this.connected = false;
      this.onStatus("Voice agent disconnected");
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answerSdp = await createRealtimeAnswer(offer.sdp ?? "");
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  setListening(active: boolean): void {
    if (this.micTrack) {
      this.micTrack.enabled = active;
      this.onStatus(active ? "Voice agent listening" : "Voice agent waiting");
    }
  }

  disconnect(): void {
    this.micTrack?.stop();
    this.dc?.close();
    this.pc?.close();
    this.connected = false;
  }

  private handleMessage(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      void this.handleFunctionCall(event.item);
      return;
    }

    if (event.type === "response.done") {
      for (const item of event.response?.output ?? []) {
        if (item.type === "function_call") {
          void this.handleFunctionCall(item);
        }
      }
    }
  }

  private async handleFunctionCall(item: RealtimeFunctionCall): Promise<void> {
    if (!item.call_id || !item.name) {
      return;
    }

    try {
      const args = item.arguments ? JSON.parse(item.arguments) : {};
      const output = await this.callTool(item.name, args);
      this.sendToolOutput(item.call_id, output);
    } catch (error) {
      this.sendToolOutput(item.call_id, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "list_threads") {
      return this.toolsState.getThreads();
    }

    if (name === "read_terminal") {
      return readTerminal(String(args.threadId), Number(args.lines ?? 80));
    }

    if (name === "draft_keystrokes") {
      const response = await createProposal({
        threadId: String(args.threadId),
        keystrokes: Array.isArray(args.keystrokes)
          ? args.keystrokes.map((item) => String(item))
          : [String(args.keystrokes ?? "")],
        displayText: String(args.displayText ?? ""),
        reason: String(args.reason ?? "")
      });
      return { status: "pending", proposalId: response.proposal.id };
    }

    if (name === "resolve_keystroke_proposal") {
      return resolveProposal(
        String(args.proposalId),
        args.decision === "approve" ? "approve" : "reject"
      );
    }

    if (name === "select_thread") {
      const threadId = String(args.threadId);
      const response = await selectThread(threadId);
      this.toolsState.setActiveThread(threadId);
      return response;
    }

    if (name === "browse_directories") {
      return browseDirectories(typeof args.path === "string" ? args.path : undefined);
    }

    if (name === "create_directory") {
      return createDirectory({
        parentPath: String(args.parentPath ?? ""),
        name: String(args.name ?? "")
      });
    }

    if (name === "create_thread") {
      const response = await createThread({
        cwd: String(args.cwd ?? ""),
        name: typeof args.name === "string" ? args.name : undefined
      });
      this.toolsState.setActiveThread(response.thread.id);
      return response;
    }

    return { error: `Unknown tool ${name}` };
  }

  private sendToolOutput(callId: string, output: unknown): void {
    if (!this.dc || this.dc.readyState !== "open") {
      this.onError("Voice agent data channel is not open");
      return;
    }

    this.dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output)
        }
      })
    );
    this.dc.send(JSON.stringify({ type: "response.create" }));
  }
}
