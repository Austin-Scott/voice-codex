import type { CodexThreadSummary, DirectoryListing, KeystrokeProposal } from "@shared/protocol";
import {
  browseDirectories,
  closeThread,
  createDirectory,
  createProposal,
  createRealtimeAnswer,
  createThread,
  readTerminal,
  resolveProposal,
  selectThread,
  updateProposal
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

export interface TerminalContext {
  threadId?: string;
  text: string;
  visibleText: string;
  aboveVisibleText: string;
  visibleStartLine: number;
  visibleEndLine: number;
  aboveVisibleStartLine: number;
  aboveVisibleEndLine: number;
}

export interface RealtimeToolsState {
  getThreads: () => { threads: CodexThreadSummary[]; activeThreadId?: string };
  getPendingProposals: () => KeystrokeProposal[];
  getTerminalContext: (aboveVisibleLines: number) => TerminalContext;
  scrollTerminal: (input: { direction: string; lines?: number }) => TerminalContext;
  setActiveThread: (threadId: string) => void;
  setThreads: (threads: CodexThreadSummary[], activeThreadId?: string) => void;
  showDirectoryListing: (listing: DirectoryListing) => void;
  showFolderPicker: () => void;
  hideFolderPicker: () => void;
}

export class RealtimeVoiceAgent {
  private pc: RTCPeerConnection | undefined;
  private dc: RTCDataChannel | undefined;
  private micTrack: MediaStreamTrack | undefined;
  private connected = false;
  private connectPromise: Promise<void> | undefined;
  private handledCallIds = new Set<string>();

  constructor(
    private readonly toolsState: RealtimeToolsState,
    private readonly onStatus: (status: string) => void,
    private readonly onError: (message: string) => void
  ) {}

  async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connect(): Promise<void> {
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
    const channelOpen = new Promise<void>((resolve, reject) => {
      dc.addEventListener("open", () => resolve(), { once: true });
      dc.addEventListener("error", () => reject(new Error("Voice agent data channel failed")), {
        once: true
      });
      dc.addEventListener("close", () => {
        if (!this.connected) {
          reject(new Error("Voice agent data channel closed before opening"));
        }
      }, { once: true });
    });
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
    await channelOpen;
  }

  setListening(active: boolean): void {
    if (this.micTrack) {
      this.micTrack.enabled = active;
      this.onStatus(active ? "Voice agent listening" : "Voice agent waiting");
    }
  }

  disconnect(): void {
    this.setListening(false);
    this.micTrack?.stop();
    this.dc?.close();
    this.pc?.close();
    this.micTrack = undefined;
    this.dc = undefined;
    this.pc = undefined;
    this.connectPromise = undefined;
    this.connected = false;
    this.handledCallIds.clear();
    this.onStatus("Voice agent idle");
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
    if (this.handledCallIds.has(item.call_id)) {
      return;
    }
    this.handledCallIds.add(item.call_id);

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

    if (name === "list_pending_proposals") {
      return { proposals: this.toolsState.getPendingProposals() };
    }

    if (name === "read_terminal") {
      const threadId = this.resolveThreadId(args.threadId);
      if (!threadId) {
        return { error: "No active Codex thread is selected." };
      }
      const context = this.toolsState.getTerminalContext(Number(args.lines ?? 120));
      if (!args.threadId || args.threadId === context.threadId) {
        return {
          threadId: context.threadId,
          text: context.text,
          visibleText: context.visibleText,
          aboveVisibleText: context.aboveVisibleText,
          source: "browser_viewport_with_above_visible_scrollback",
          visibleStartLine: context.visibleStartLine,
          visibleEndLine: context.visibleEndLine,
          aboveVisibleStartLine: context.aboveVisibleStartLine,
          aboveVisibleEndLine: context.aboveVisibleEndLine,
          note:
            "aboveVisibleText is terminal scrollback above the user's current viewport and is not currently visible to the user. visibleText is what is currently displayed."
        };
      }
      return readTerminal(threadId, Number(args.lines ?? 120));
    }

    if (name === "scroll_terminal") {
      return this.toolsState.scrollTerminal({
        direction: String(args.direction ?? ""),
        lines: typeof args.lines === "number" ? args.lines : undefined
      });
    }

    if (name === "draft_keystrokes") {
      const threadId = this.resolveThreadId(args.threadId);
      if (!threadId) {
        return { error: "No active Codex thread is selected." };
      }
      const response = await createProposal({
        threadId,
        keystrokes: Array.isArray(args.keystrokes)
          ? args.keystrokes.map((item) => String(item))
          : [String(args.keystrokes ?? "")],
        displayText: String(args.displayText ?? ""),
        reason: String(args.reason ?? "")
      });
      return { status: "pending", proposalId: response.proposal.id };
    }

    if (name === "update_keystroke_proposal") {
      return updateProposal({
        proposalId: String(args.proposalId ?? ""),
        keystrokes: Array.isArray(args.keystrokes)
          ? args.keystrokes.map((item) => String(item))
          : [String(args.keystrokes ?? args.displayText ?? "")],
        displayText: String(args.displayText ?? ""),
        reason: typeof args.reason === "string" ? args.reason : undefined
      });
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

    if (name === "close_thread") {
      const threadId = this.resolveThreadId(args.threadId);
      if (!threadId) {
        return { error: "No active Codex thread is selected." };
      }
      const response = await closeThread(threadId);
      this.toolsState.setThreads(response.threads, response.activeThreadId);
      return response;
    }

    if (name === "browse_directories") {
      this.toolsState.showFolderPicker();
      const response = await browseDirectories(typeof args.path === "string" ? args.path : undefined);
      this.toolsState.showDirectoryListing(response.listing);
      return response;
    }

    if (name === "create_directory") {
      this.toolsState.showFolderPicker();
      const response = await createDirectory({
        parentPath: String(args.parentPath ?? ""),
        name: String(args.name ?? "")
      });
      this.toolsState.showDirectoryListing(response.listing);
      return response;
    }

    if (name === "create_thread") {
      const response = await createThread({
        cwd: String(args.cwd ?? ""),
        name: typeof args.name === "string" ? args.name : undefined
      });
      this.toolsState.setActiveThread(response.thread.id);
      this.toolsState.hideFolderPicker();
      return response;
    }

    return { error: `Unknown tool ${name}` };
  }

  private resolveThreadId(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    return this.toolsState.getThreads().activeThreadId;
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
