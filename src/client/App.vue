<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type {
  CodexThreadSummary,
  DirectoryListing,
  ImageModalRequest,
  KeystrokeProposal,
  ServerEvent,
  SessionResponse,
  TerminalFramePayload,
  TurnSummary
} from "@shared/protocol";
import {
  browseDirectories,
  createDirectory,
  createThread,
  getTerminalSnapshot,
  getSession,
  listThreads,
  pair,
  resolveProposal,
  selectThread,
  stopThread,
  synthesizeSpeech,
  transcribe
} from "./api";
import {
  DEFAULT_PEDAL_BINDINGS,
  PedalInput,
  type PedalBindings,
  type PedalHandlers
} from "./pedal";
import { RealtimeVoiceAgent, type TerminalContext } from "./realtime";
import { VoiceCodexSocket } from "./socket";
import { getLatestContentScrollLine, shouldRenderTerminalFrame } from "./terminalFrames";

interface MinimalWakeLockSentinel {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: AddEventListenerOptions) => void;
}

interface SummaryToast {
  id: string;
  summary: TurnSummary;
  leaving: boolean;
  dragging: boolean;
  startX: number;
  offsetX: number;
  pointerId?: number;
  dismissTimer?: ReturnType<typeof window.setTimeout>;
  removalTimer?: ReturnType<typeof window.setTimeout>;
}

const session = ref<SessionResponse | undefined>();
const errorMessage = ref("");
const statusMessage = ref("Loading");
const wsStatus = ref<"open" | "closed">("closed");
const agentStatus = ref("Voice agent idle");
const whisperStatus = ref("Whisper idle");
const threads = ref<CodexThreadSummary[]>([]);
const activeThreadId = ref<string | undefined>();
const proposals = ref<KeystrokeProposal[]>([]);
const turnSummaries = ref<TurnSummary[]>([]);
const summaryToasts = ref<SummaryToast[]>([]);
const terminalElement = ref<HTMLDivElement | null>(null);
const captureBinding = ref<keyof PedalBindings | undefined>();
const qrHostInput = ref("");
const settingsOpen = ref(false);
const folderPickerOpen = ref(false);
const directoryListing = ref<DirectoryListing | undefined>();
const newDirectoryName = ref("");
const touchOverlayEnabled = ref(loadTouchOverlayEnabled());
const overlayPtt = ref<"agent" | "whisper" | undefined>();
const alwaysListening = ref(false);
const spokenSummariesEnabled = ref(loadSpokenSummariesEnabled());
const fullscreenActive = ref(Boolean(document.fullscreenElement));
const pendingClipboardCopy = ref<{ text: string; message: string } | undefined>();
const imageModalRequest = ref<ImageModalRequest | undefined>();
const imageModalIndex = ref(0);
const bindings = reactive<PedalBindings>(loadPedalBindings());

let socket: VoiceCodexSocket | undefined;
let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let pedal: PedalInput | undefined;
let voiceAgent: RealtimeVoiceAgent | undefined;
let agentPressed = false;
let whisperRecorder: MediaRecorder | undefined;
let whisperStream: MediaStream | undefined;
let whisperChunks: Blob[] = [];
let agentIdleTimer: ReturnType<typeof window.setTimeout> | undefined;
let wakeLock: MinimalWakeLockSentinel | undefined;
let pageWasHidden = document.visibilityState === "hidden";
let summarySpeechQueue = Promise.resolve();
let controllerSessionCheckTimer: ReturnType<typeof window.setTimeout> | undefined;
const lastFrameSequences = new Map<string, number>();

const isController = computed(() => Boolean(session.value?.isController));
const activeThread = computed(() => threads.value.find((thread) => thread.id === activeThreadId.value));
const pendingProposals = computed(() =>
  proposals.value.filter((proposal) => proposal.status === "pending")
);
const activeSummaryToasts = computed(() => summaryToasts.value.slice(0, 3));
const imageModalImage = computed(() => imageModalRequest.value?.images[imageModalIndex.value]);

onMounted(async () => {
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("keyup", handleKeyUp, true);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("online", handleWindowOnline);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("pointerdown", handleWakeLockGesture, { passive: true });
  await loadSession();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeyDown, true);
  window.removeEventListener("keyup", handleKeyUp, true);
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("online", handleWindowOnline);
  window.removeEventListener("pageshow", handlePageShow);
  window.removeEventListener("pointerdown", handleWakeLockGesture);
  resizeObserver?.disconnect();
  pedal?.dispose();
  releaseOverlayPtt();
  clearAgentIdleTimer();
  clearControllerSessionCheckTimer();
  clearSummaryToasts();
  voiceAgent?.disconnect();
  void releaseWakeLock();
  socket?.close();
});

async function loadSession(): Promise<void> {
  errorMessage.value = "";
  session.value = await getSession();
  syncQrHostInput();
  const pairToken = new URLSearchParams(window.location.search).get("pair");
  if (pairToken && !session.value.isController) {
    await submitPairToken(pairToken);
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  if (session.value.isController) {
    await initializeController();
  } else {
    statusMessage.value = "Waiting for pairing";
  }
}

async function submitPairToken(token: string): Promise<void> {
  try {
    errorMessage.value = "";
    await pair(token);
    session.value = await getSession();
    syncQrHostInput();
    await initializeController();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function refreshPairingQr(): Promise<void> {
  try {
    errorMessage.value = "";
    session.value = await getSession(qrHostInput.value);
    syncQrHostInput();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function initializeController(): Promise<void> {
  statusMessage.value = "Paired";
  await refreshThreads();
  setupVoiceAgent();
  setupPedal();
  connectSocket();
  await nextTick();
  setupTerminal();
  void requestWakeLock();
}

async function refreshThreads(): Promise<void> {
  const response = await listThreads();
  threads.value = response.threads;
  activeThreadId.value = response.activeThreadId;
}

function setupVoiceAgent(): void {
  voiceAgent = new RealtimeVoiceAgent(
    {
      getThreads: () => ({ threads: threads.value, activeThreadId: activeThreadId.value }),
      getPendingProposals: () => pendingProposals.value,
      getTerminalContext,
      scrollTerminal,
      setAlwaysListening,
      copyToClipboard: copyTextToControllerClipboard,
      setActiveThread: (threadId) => {
        activeThreadId.value = threadId;
        void loadThreadSnapshot(threadId);
      },
      setThreads: (nextThreads, nextActiveThreadId) => {
        threads.value = nextThreads;
        activeThreadId.value = nextActiveThreadId;
        clearTerminal();
        if (nextActiveThreadId) {
          void loadThreadSnapshot(nextActiveThreadId);
        }
      },
      showDirectoryListing: (listing) => {
        directoryListing.value = listing;
        folderPickerOpen.value = true;
      },
      showFolderPicker: () => {
        folderPickerOpen.value = true;
      },
      hideFolderPicker: () => {
        folderPickerOpen.value = false;
      },
      getTurnSummaries: (threadId) =>
        threadId
          ? turnSummaries.value.filter((summary) => summary.threadId === threadId)
          : turnSummaries.value,
      getLatestTurnSummary: (threadId) =>
        (threadId
          ? turnSummaries.value.filter((summary) => summary.threadId === threadId)
          : turnSummaries.value)[0],
      getImageModalState,
      controlImageModal
    },
    (status) => {
      agentStatus.value = status;
    },
    (message) => {
      errorMessage.value = message;
    }
  );
}

function setupPedal(): void {
  const handlers: PedalHandlers = {
    onAgentDown: () => {
      handleAgentDown();
    },
    onAgentUp: () => {
      handleAgentUp();
    },
    onWhisperDown: () => {
      void startWhisper();
    },
    onWhisperUp: () => {
      void stopWhisper();
    },
    onActionEnter: () => sendTerminal("\r"),
    onActionEsc: () => sendTerminal("\u001b")
  };
  pedal = new PedalInput({ ...bindings }, handlers);
}

function connectSocket(): void {
  socket?.close();
  socket = new VoiceCodexSocket(
    handleServerEvent,
    (status) => {
      wsStatus.value = status;
      if (status === "open" && activeThreadId.value) {
        if (errorMessage.value === "Controller is reconnecting. Try again in a moment.") {
          errorMessage.value = "";
        }
        void loadThreadSnapshot(activeThreadId.value);
      } else if (status === "closed" && isController.value) {
        scheduleControllerSessionCheck();
      }
    },
    (message) => {
      errorMessage.value = message;
    }
  );
  socket.connect();
}

function setupTerminal(): void {
  if (!terminalElement.value || terminal) {
    return;
  }

  terminal = new Terminal({
    allowProposedApi: true,
    scrollback: 300,
    cursorBlink: true,
    convertEol: false,
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 14,
    theme: {
      background: "#0d1117",
      foreground: "#d6deeb",
      cursor: "#f8f8f2",
      selectionBackground: "#394b59"
    }
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalElement.value);
  terminal.onData((data) => sendTerminal(data));

  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit();
    if (activeThreadId.value && terminal) {
      socket?.send({
        type: "terminal.resize",
        threadId: activeThreadId.value,
        cols: terminal.cols,
        rows: terminal.rows
      });
    }
  });
  resizeObserver.observe(terminalElement.value);
  fitAddon.fit();
}

function handleServerEvent(event: ServerEvent): void {
  if (event.type === "threads") {
    const previousActiveThreadId = activeThreadId.value;
    threads.value = event.threads;
    const localSelectionStillExists = event.threads.some((thread) => thread.id === activeThreadId.value);
    if (!localSelectionStillExists) {
      activeThreadId.value = event.activeThreadId;
      clearTerminal();
      if (event.activeThreadId && event.activeThreadId !== previousActiveThreadId) {
        void loadThreadSnapshot(event.activeThreadId);
      }
    }
    return;
  }

  if (event.type === "thread.status") {
    upsertThread(event.thread);
    return;
  }

  if (event.type === "terminal.delta") {
    return;
  }

  if (event.type === "terminal.snapshot") {
    renderTerminalFrame(event);
    return;
  }

  if (event.type === "terminal.frame") {
    renderTerminalFrame(event);
    return;
  }

  if (event.type === "proposal.created") {
    upsertProposal(event.proposal);
    return;
  }

  if (event.type === "proposals") {
    proposals.value = event.proposals;
    return;
  }

  if (event.type === "proposal.updated") {
    upsertProposal(event.proposal);
    return;
  }

  if (event.type === "proposal.resolved") {
    removeProposal(event.proposal.id);
    return;
  }

  if (event.type === "turn_summaries") {
    turnSummaries.value = event.summaries;
    return;
  }

  if (event.type === "turn_summary.created") {
    upsertTurnSummary(event.summary);
    showSummaryToast(event.summary);
    return;
  }

  if (event.type === "image_modal.open") {
    openImageModal(event.request);
    return;
  }

  if (event.type === "error") {
    errorMessage.value = event.message;
  }
}

function scheduleControllerSessionCheck(): void {
  if (controllerSessionCheckTimer) {
    return;
  }

  controllerSessionCheckTimer = window.setTimeout(() => {
    controllerSessionCheckTimer = undefined;
    void verifyControllerSession();
  }, 750);
}

async function verifyControllerSession(): Promise<void> {
  try {
    const nextSession = await getSession(qrHostInput.value);
    if (nextSession.isController) {
      session.value = nextSession;
      syncQrHostInput();
      return;
    }

    session.value = nextSession;
    syncQrHostInput();
    resetControllerRuntime();
    statusMessage.value = "Waiting for pairing";
    errorMessage.value = "Controller session expired. Pair this browser again.";
  } catch {
    if (isController.value) {
      scheduleControllerSessionCheck();
    }
  }
}

function resetControllerRuntime(): void {
  clearControllerSessionCheckTimer();
  clearAgentIdleTimer();
  releaseOverlayPtt();
  voiceAgent?.disconnect();
  voiceAgent = undefined;
  pedal?.dispose();
  pedal = undefined;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  terminal?.dispose();
  terminal = undefined;
  fitAddon = undefined;
  socket?.close();
  socket = undefined;
  activeThreadId.value = undefined;
  threads.value = [];
  proposals.value = [];
  turnSummaries.value = [];
  clearSummaryToasts();
  folderPickerOpen.value = false;
  settingsOpen.value = false;
  imageModalRequest.value = undefined;
  pendingClipboardCopy.value = undefined;
  lastFrameSequences.clear();
}

function clearControllerSessionCheckTimer(): void {
  if (controllerSessionCheckTimer) {
    window.clearTimeout(controllerSessionCheckTimer);
    controllerSessionCheckTimer = undefined;
  }
}

async function createNewThread(): Promise<void> {
  if (!directoryListing.value) {
    return;
  }

  try {
    errorMessage.value = "";
    const response = await createThread({
      cwd: directoryListing.value.current
    });
    upsertThread(response.thread);
    activeThreadId.value = response.thread.id;
    clearTerminal();
    await loadThreadSnapshot(response.thread.id);
    folderPickerOpen.value = false;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    void verifyControllerSession();
  }
}

async function openFolderPicker(): Promise<void> {
  folderPickerOpen.value = true;
  if (!directoryListing.value) {
    await loadDirectory();
  }
}

async function loadDirectory(path?: string): Promise<void> {
  try {
    errorMessage.value = "";
    const response = await browseDirectories(path);
    directoryListing.value = response.listing;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function createFolder(): Promise<void> {
  if (!directoryListing.value || !newDirectoryName.value.trim()) {
    return;
  }

  try {
    errorMessage.value = "";
    const response = await createDirectory({
      parentPath: directoryListing.value.current,
      name: newDirectoryName.value
    });
    directoryListing.value = response.listing;
    newDirectoryName.value = "";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function chooseThread(threadId: string): Promise<void> {
  try {
    await selectThread(threadId);
    activeThreadId.value = threadId;
    clearTerminal();
    await loadThreadSnapshot(threadId);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function stopSelectedThread(): Promise<void> {
  if (!activeThreadId.value) {
    return;
  }
  const threadId = activeThreadId.value;
  try {
    await stopThread(threadId);
    removeThread(threadId);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function approveProposal(proposal: KeystrokeProposal): Promise<void> {
  const response = await resolveProposal(proposal.id, "approve");
  removeProposal(response.proposal.id);
}

async function rejectProposal(proposal: KeystrokeProposal): Promise<void> {
  const response = await resolveProposal(proposal.id, "reject");
  removeProposal(response.proposal.id);
}

function requestSnapshot(threadId: string): void {
  socket?.send({ type: "thread.select", threadId });
}

async function loadThreadSnapshot(threadId: string): Promise<void> {
  try {
    const snapshot = await getTerminalSnapshot(threadId);
    renderTerminalFrame(snapshot);
  } catch {
    requestSnapshot(threadId);
  }
}

function renderTerminalFrame(frame: TerminalFramePayload): void {
  if (frame.threadId !== activeThreadId.value) {
    return;
  }

  const previousSequence = lastFrameSequences.get(frame.threadId);
  if (!shouldRenderTerminalFrame(previousSequence, frame.sequence)) {
    return;
  }

  lastFrameSequences.set(frame.threadId, frame.sequence);
  replaceTerminalContent(frame.data);
}

function sendTerminal(data: string): void {
  if (!activeThreadId.value) {
    errorMessage.value = "Create or select a Codex thread first.";
    return;
  }
  if (!socket?.send({ type: "terminal.input", threadId: activeThreadId.value, data })) {
    errorMessage.value = "Controller is reconnecting. Try again in a moment.";
  }
}

async function pasteClipboardToTerminal(): Promise<void> {
  if (!navigator.clipboard?.readText) {
    errorMessage.value = "Clipboard paste is not available in this browser.";
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text.length > 0) {
      sendTerminal(text);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Clipboard paste was blocked.";
  }
}

async function copyTextToControllerClipboard(
  text: string
): Promise<{ copied: boolean; pendingUserGesture?: boolean; error?: string }> {
  if (!text) {
    return { copied: false, error: "No text was provided to copy." };
  }

  try {
    await writeClipboardText(text);
    pendingClipboardCopy.value = undefined;
    return { copied: true };
  } catch (error) {
    pendingClipboardCopy.value = {
      text,
      message: `Tap Copy to place ${text.length.toLocaleString()} characters on this device's clipboard.`
    };
    return {
      copied: false,
      pendingUserGesture: true,
      error: error instanceof Error ? error.message : "Clipboard copy was blocked."
    };
  }
}

async function copyPendingClipboardText(): Promise<void> {
  const pending = pendingClipboardCopy.value;
  if (!pending) {
    return;
  }

  try {
    await writeClipboardText(pending.text);
    pendingClipboardCopy.value = undefined;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Clipboard copy was blocked.";
  }
}

function dismissPendingClipboardCopy(): void {
  pendingClipboardCopy.value = undefined;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      if (!copyTextWithLegacyCommand(text)) {
        throw error;
      }
      return;
    }
  }

  if (copyTextWithLegacyCommand(text)) {
    return;
  }

  throw new Error("Clipboard copy is not available in this browser.");
}

function copyTextWithLegacyCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus();
  }

  return copied;
}

async function startAgentPushToTalk(): Promise<void> {
  try {
    clearAgentIdleTimer();
    await voiceAgent?.ensureConnected();
    if (agentPressed || alwaysListening.value) {
      voiceAgent?.setListening(true);
      if (alwaysListening.value) {
        agentStatus.value = "Voice agent always listening";
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function handleAgentDown(): void {
  agentPressed = true;
  clearAgentIdleTimer();
  void startAgentPushToTalk();
}

function handleAgentUp(): void {
  agentPressed = false;
  if (alwaysListening.value) {
    voiceAgent?.setListening(true);
    agentStatus.value = "Voice agent always listening";
  } else {
    voiceAgent?.setListening(false);
    scheduleAgentIdleDisconnect();
  }
}

function scheduleAgentIdleDisconnect(): void {
  if (alwaysListening.value) {
    clearAgentIdleTimer();
    return;
  }

  clearAgentIdleTimer();
  agentIdleTimer = window.setTimeout(() => {
    agentIdleTimer = undefined;
    if (!agentPressed && !alwaysListening.value) {
      voiceAgent?.disconnect();
    }
  }, 120_000);
}

function clearAgentIdleTimer(): void {
  if (agentIdleTimer) {
    window.clearTimeout(agentIdleTimer);
    agentIdleTimer = undefined;
  }
}

async function startWhisper(): Promise<void> {
  if (whisperRecorder) {
    return;
  }

  try {
    whisperStatus.value = "Whisper recording";
    whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    whisperChunks = [];
    const options = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? { mimeType: "audio/webm;codecs=opus" }
      : undefined;
    whisperRecorder = new MediaRecorder(whisperStream, options);
    whisperRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        whisperChunks.push(event.data);
      }
    });
    whisperRecorder.start();
  } catch (error) {
    whisperStatus.value = "Whisper idle";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function stopWhisper(): Promise<void> {
  const recorder = whisperRecorder;
  if (!recorder) {
    return;
  }

  whisperStatus.value = "Transcribing";
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.stop();
  await stopped;
  whisperRecorder = undefined;
  whisperStream?.getTracks().forEach((track) => track.stop());
  whisperStream = undefined;

  try {
    const blob = new Blob(whisperChunks, { type: recorder.mimeType || "audio/webm" });
    whisperChunks = [];
    const response = await transcribe(blob);
    if (response.text.trim()) {
      sendTerminal(response.text);
    }
    whisperStatus.value = "Whisper idle";
  } catch (error) {
    whisperStatus.value = "Whisper idle";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  if (captureBinding.value) {
    bindings[captureBinding.value] = event.code;
    savePedalBindings(bindings);
    pedal?.setBindings({ ...bindings });
    captureBinding.value = undefined;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (pedal?.keyDown(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  if (pedal?.keyUp(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function handleFullscreenChange(): void {
  fullscreenActive.value = Boolean(document.fullscreenElement);
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    pageWasHidden = true;
    return;
  }

  void requestWakeLock();
  resumeControllerConnection(pageWasHidden);
  pageWasHidden = false;
}

function handleWindowFocus(): void {
  resumeControllerConnection(false);
}

function handleWindowOnline(): void {
  resumeControllerConnection(true);
}

function handlePageShow(event: PageTransitionEvent): void {
  resumeControllerConnection(event.persisted);
}

function resumeControllerConnection(forceReconnect: boolean): void {
  if (!isController.value || !socket) {
    return;
  }

  if (forceReconnect) {
    socket.reconnectNow();
  } else {
    socket.connect();
  }

  if (activeThreadId.value) {
    void loadThreadSnapshot(activeThreadId.value);
  }
}

function handleWakeLockGesture(): void {
  if (!wakeLock && isController.value) {
    void requestWakeLock();
  }
}

function upsertThread(thread: CodexThreadSummary): void {
  if (thread.state === "exited") {
    removeThread(thread.id);
    return;
  }

  const index = threads.value.findIndex((existing) => existing.id === thread.id);
  if (index >= 0) {
    threads.value.splice(index, 1, thread);
  } else {
    threads.value.push(thread);
  }
}

function removeThread(threadId: string): void {
  const index = threads.value.findIndex((existing) => existing.id === threadId);
  if (index >= 0) {
    threads.value.splice(index, 1);
  }
  if (activeThreadId.value === threadId) {
    activeThreadId.value = threads.value[0]?.id;
    clearTerminal();
    if (activeThreadId.value) {
      void loadThreadSnapshot(activeThreadId.value);
    }
  }
}

function upsertProposal(proposal: KeystrokeProposal): void {
  if (proposal.status !== "pending") {
    removeProposal(proposal.id);
    return;
  }

  const index = proposals.value.findIndex((existing) => existing.id === proposal.id);
  if (index >= 0) {
    proposals.value.splice(index, 1, proposal);
  } else {
    proposals.value.unshift(proposal);
  }
}

function removeProposal(proposalId: string): void {
  const index = proposals.value.findIndex((existing) => existing.id === proposalId);
  if (index >= 0) {
    proposals.value.splice(index, 1);
  }
}

function upsertTurnSummary(summary: TurnSummary): void {
  const index = turnSummaries.value.findIndex((existing) => existing.id === summary.id);
  if (index >= 0) {
    turnSummaries.value.splice(index, 1);
  }
  turnSummaries.value.unshift(summary);
  if (turnSummaries.value.length > 80) {
    turnSummaries.value.length = 80;
  }
}

function showSummaryToast(summary: TurnSummary): void {
  const existing = summaryToasts.value.find((toast) => toast.id === summary.id);
  if (existing) {
    existing.summary = summary;
    existing.leaving = false;
    existing.offsetX = 0;
    return;
  }

  const toast: SummaryToast = {
    id: summary.id,
    summary,
    leaving: false,
    dragging: false,
    startX: 0,
    offsetX: 0
  };
  summaryToasts.value.unshift(toast);

  for (const staleToast of summaryToasts.value.slice(3)) {
    dismissSummaryToast(staleToast.id);
  }

  if (spokenSummariesEnabled.value) {
    void enqueueSummarySpeech(summary).then(() => dismissSummaryToast(summary.id));
  } else {
    scheduleSummaryToastDismissal(summary.id, 15_000);
  }
}

function enqueueSummarySpeech(summary: TurnSummary): Promise<void> {
  const playback = summarySpeechQueue
    .catch(() => undefined)
    .then(() => playSummarySpeech(summary));
  summarySpeechQueue = playback.catch(() => undefined);

  return playback.catch((error: unknown) => {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    return new Promise<void>((resolve) => window.setTimeout(resolve, 15_000));
  });
}

function scheduleSummaryToastDismissal(summaryId: string, delayMs: number): void {
  const toast = summaryToasts.value.find((candidate) => candidate.id === summaryId);
  if (!toast) {
    return;
  }

  clearSummaryToastTimers(toast, "dismiss");
  toast.dismissTimer = window.setTimeout(() => {
    toast.dismissTimer = undefined;
    dismissSummaryToast(summaryId);
  }, delayMs);
}

function dismissSummaryToast(summaryId: string, direction = 1): void {
  const toast = summaryToasts.value.find((candidate) => candidate.id === summaryId);
  if (!toast || toast.leaving) {
    return;
  }

  clearSummaryToastTimers(toast, "all");
  toast.dragging = false;
  toast.leaving = true;
  toast.offsetX = direction * Math.max(window.innerWidth, 480);
  toast.removalTimer = window.setTimeout(() => {
    removeSummaryToast(summaryId);
  }, 240);
}

function removeSummaryToast(summaryId: string): void {
  const index = summaryToasts.value.findIndex((toast) => toast.id === summaryId);
  if (index < 0) {
    return;
  }

  clearSummaryToastTimers(summaryToasts.value[index], "all");
  summaryToasts.value.splice(index, 1);
}

function clearSummaryToastTimers(toast: SummaryToast, mode: "dismiss" | "all"): void {
  if (toast.dismissTimer) {
    window.clearTimeout(toast.dismissTimer);
    toast.dismissTimer = undefined;
  }
  if (mode === "all" && toast.removalTimer) {
    window.clearTimeout(toast.removalTimer);
    toast.removalTimer = undefined;
  }
}

function clearSummaryToasts(): void {
  for (const toast of summaryToasts.value) {
    clearSummaryToastTimers(toast, "all");
  }
  summaryToasts.value = [];
}

function startSummaryToastSwipe(toast: SummaryToast, event: PointerEvent): void {
  if (toast.leaving || (event.pointerType === "mouse" && event.button !== 0)) {
    return;
  }

  toast.dragging = true;
  toast.pointerId = event.pointerId;
  toast.startX = event.clientX - toast.offsetX;
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
}

function updateSummaryToastSwipe(toast: SummaryToast, event: PointerEvent): void {
  if (!toast.dragging || toast.pointerId !== event.pointerId) {
    return;
  }

  toast.offsetX = event.clientX - toast.startX;
}

function finishSummaryToastSwipe(toast: SummaryToast, event: PointerEvent): void {
  if (!toast.dragging || toast.pointerId !== event.pointerId) {
    return;
  }

  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const width = event.currentTarget instanceof HTMLElement ? event.currentTarget.offsetWidth : 360;
  const shouldDismiss = Math.abs(toast.offsetX) > Math.min(160, width * 0.36);
  const direction = toast.offsetX < 0 ? -1 : 1;
  toast.dragging = false;
  toast.pointerId = undefined;

  if (shouldDismiss) {
    dismissSummaryToast(toast.id, direction);
  } else {
    toast.offsetX = 0;
  }
}

function summaryToastStyle(toast: SummaryToast): Record<string, string> {
  const distance = Math.abs(toast.offsetX);
  const style: Record<string, string> = {};
  if (toast.offsetX !== 0) {
    style.transform = `translateX(${toast.offsetX}px)`;
  }
  if (toast.dragging) {
    style.opacity = String(Math.max(0.26, 0.86 - Math.min(distance / 420, 0.58)));
  }
  return style;
}

async function playSummarySpeech(summary: TurnSummary): Promise<void> {
  const blob = await synthesizeSpeech(`${summary.threadName}. ${summary.summary}`);
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      audio.addEventListener("ended", () => resolve(), { once: true });
      audio.addEventListener("error", () => reject(new Error("Unable to play summary audio.")), {
        once: true
      });
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openImageModal(request: ImageModalRequest): void {
  imageModalRequest.value = request;
  imageModalIndex.value = 0;
}

function closeImageModal(): void {
  imageModalRequest.value = undefined;
  imageModalIndex.value = 0;
}

function selectImageModalIndex(index: number): void {
  const request = imageModalRequest.value;
  if (!request) {
    return;
  }

  imageModalIndex.value = Math.max(0, Math.min(request.images.length - 1, index));
}

function getImageModalState(): {
  open: boolean;
  request?: ImageModalRequest;
  selectedIndex: number;
  selectedImage?: ImageModalRequest["images"][number];
} {
  return {
    open: Boolean(imageModalRequest.value),
    request: imageModalRequest.value,
    selectedIndex: imageModalIndex.value,
    selectedImage: imageModalImage.value
  };
}

function controlImageModal(input: { action: string; index?: number }): {
  open: boolean;
  selectedIndex: number;
  selectedImage?: ImageModalRequest["images"][number];
  error?: string;
} {
  const request = imageModalRequest.value;
  if (!request) {
    return { open: false, selectedIndex: 0, error: "No image modal is open." };
  }

  const action = input.action.toLowerCase();
  if (action === "close") {
    closeImageModal();
    return { open: false, selectedIndex: 0 };
  }
  if (action === "next") {
    selectImageModalIndex(imageModalIndex.value + 1);
  } else if (action === "previous") {
    selectImageModalIndex(imageModalIndex.value - 1);
  } else if (action === "select") {
    selectImageModalIndex(Number(input.index ?? imageModalIndex.value));
  } else {
    return {
      open: true,
      selectedIndex: imageModalIndex.value,
      selectedImage: imageModalImage.value,
      error: `Unknown image modal action ${input.action}`
    };
  }

  return {
    open: true,
    selectedIndex: imageModalIndex.value,
    selectedImage: imageModalImage.value
  };
}

function writeTerminal(data: string): void {
  if (!terminal) {
    return;
  }
  terminal.write(data, () => {
    scrollToLatestTerminalContent();
  });
}

function clearTerminal(): void {
  lastFrameSequences.delete(activeThreadId.value ?? "");
  terminal?.write("\x1bc");
}

function replaceTerminalContent(data: string): void {
  if (!terminal) {
    return;
  }

  terminal.write(`\x1bc${data}`, () => {
    scrollToLatestTerminalContent();
  });
}

function scrollToLatestTerminalContent(): void {
  if (!terminal) {
    return;
  }

  const buffer = terminal.buffer.active;
  terminal.scrollToLine(
    getLatestContentScrollLine({
      bufferLength: buffer.length,
      rows: terminal.rows,
      lineAt: (index) => buffer.getLine(index)?.translateToString(true)
    })
  );
}

function getTerminalContext(aboveVisibleLines: number): TerminalContext {
  if (!terminal) {
    return {
      threadId: activeThreadId.value,
      text: "",
      visibleText: "",
      aboveVisibleText: "",
      visibleStartLine: 0,
      visibleEndLine: 0,
      aboveVisibleStartLine: 0,
      aboveVisibleEndLine: 0
    };
  }

  const buffer = terminal.buffer.active;
  const visibleStartLine = buffer.viewportY;
  const visibleEndLine = Math.min(buffer.length - 1, visibleStartLine + terminal.rows - 1);
  const aboveVisibleEndLine = Math.max(-1, visibleStartLine - 1);
  const aboveVisibleStartLine =
    aboveVisibleEndLine >= 0 ? Math.max(0, aboveVisibleEndLine - Math.max(0, aboveVisibleLines) + 1) : 0;
  const visibleText = readTerminalLines(visibleStartLine, visibleEndLine);
  const aboveVisibleText =
    aboveVisibleEndLine >= aboveVisibleStartLine
      ? readTerminalLines(aboveVisibleStartLine, aboveVisibleEndLine)
      : "";
  const text = [
    aboveVisibleText
      ? `[Not currently visible: scrollback above the user's viewport, lines ${aboveVisibleStartLine}-${aboveVisibleEndLine}]\n${aboveVisibleText}`
      : "",
    `[Currently visible to the user, lines ${visibleStartLine}-${visibleEndLine}]\n${visibleText}`
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    threadId: activeThreadId.value,
    text,
    visibleText,
    aboveVisibleText,
    visibleStartLine,
    visibleEndLine,
    aboveVisibleStartLine,
    aboveVisibleEndLine
  };
}

function readTerminalLines(startLine: number, endLine: number): string {
  if (!terminal || endLine < startLine) {
    return "";
  }

  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = startLine; index <= endLine; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }

  return lines.join("\n").replace(/\s+$/g, "");
}

function scrollTerminal(input: { direction: string; lines?: number }): TerminalContext {
  if (!terminal) {
    return getTerminalContext(120);
  }

  const direction = input.direction.toLowerCase();
  const buffer = terminal.buffer.active;
  const maxViewportLine = Math.max(0, buffer.length - terminal.rows);
  const lineCount = Number.isFinite(input.lines) ? Math.max(1, Math.min(300, Number(input.lines))) : terminal.rows;

  if (direction === "top") {
    terminal.scrollToTop();
  } else if (direction === "bottom") {
    terminal.scrollToBottom();
  } else if (direction === "up") {
    terminal.scrollToLine(Math.max(0, buffer.viewportY - lineCount));
  } else if (direction === "down") {
    terminal.scrollToLine(Math.min(maxViewportLine, buffer.viewportY + lineCount));
  }

  return getTerminalContext(120);
}

async function setAlwaysListening(enabled: boolean): Promise<{ alwaysListening: boolean }> {
  alwaysListening.value = enabled;
  clearAgentIdleTimer();

  if (enabled) {
    try {
      await voiceAgent?.ensureConnected();
      voiceAgent?.setListening(true);
      agentStatus.value = "Voice agent always listening";
    } catch (error) {
      alwaysListening.value = false;
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } else if (agentPressed) {
    voiceAgent?.setListening(true);
  } else {
    voiceAgent?.setListening(false);
    scheduleAgentIdleDisconnect();
  }

  return { alwaysListening: alwaysListening.value };
}

function onAlwaysListeningChange(): void {
  void setAlwaysListening(alwaysListening.value);
}

async function requestWakeLock(): Promise<void> {
  if (!isController.value || wakeLock || document.visibilityState !== "visible") {
    return;
  }

  const wakeLockApi = (
    navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<MinimalWakeLockSentinel> };
    }
  ).wakeLock;
  if (!wakeLockApi) {
    return;
  }

  try {
    wakeLock = await wakeLockApi.request("screen");
    wakeLock.addEventListener(
      "release",
      () => {
        wakeLock = undefined;
      },
      { once: true }
    );
  } catch {
    wakeLock = undefined;
  }
}

async function releaseWakeLock(): Promise<void> {
  const current = wakeLock;
  wakeLock = undefined;
  await current?.release().catch(() => undefined);
}

function loadPedalBindings(): PedalBindings {
  const stored = window.localStorage.getItem("voice-codex-pedal-bindings");
  if (!stored) {
    return { ...DEFAULT_PEDAL_BINDINGS };
  }

  try {
    return { ...DEFAULT_PEDAL_BINDINGS, ...(JSON.parse(stored) as Partial<PedalBindings>) };
  } catch {
    return { ...DEFAULT_PEDAL_BINDINGS };
  }
}

function savePedalBindings(value: PedalBindings): void {
  window.localStorage.setItem("voice-codex-pedal-bindings", JSON.stringify(value));
}

function loadTouchOverlayEnabled(): boolean {
  return window.localStorage.getItem("voice-codex-touch-overlay") === "true";
}

function loadSpokenSummariesEnabled(): boolean {
  return window.localStorage.getItem("voice-codex-spoken-summaries") === "true";
}

function saveTouchOverlayEnabled(): void {
  window.localStorage.setItem("voice-codex-touch-overlay", String(touchOverlayEnabled.value));
  if (!touchOverlayEnabled.value) {
    releaseOverlayPtt();
  }
}

function saveSpokenSummariesEnabled(): void {
  window.localStorage.setItem("voice-codex-spoken-summaries", String(spokenSummariesEnabled.value));
}

function handleOverlayPttDown(kind: "agent" | "whisper", event: PointerEvent): void {
  if (overlayPtt.value === kind) {
    return;
  }

  releaseOverlayPtt();
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  overlayPtt.value = kind;

  if (kind === "agent") {
    handleAgentDown();
  } else {
    void startWhisper();
  }
}

function handleOverlayPttUp(kind: "agent" | "whisper", event: PointerEvent): void {
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  if (overlayPtt.value === kind) {
    releaseOverlayPtt();
  }
}

function syncQrHostInput(): void {
  if (!session.value?.pairing.controllerUrl) {
    return;
  }

  try {
    qrHostInput.value = new URL(session.value.pairing.controllerUrl).host;
  } catch {
    // Leave user input as-is if the URL cannot be parsed.
  }
}

function releaseOverlayPtt(): void {
  const active = overlayPtt.value;
  overlayPtt.value = undefined;
  if (active === "agent") {
    handleAgentUp();
  } else if (active === "whisper") {
    void stopWhisper();
  }
}
</script>

<template>
  <main v-if="!isController" class="pairing-screen">
    <section class="pairing-panel">
      <div>
        <p class="text-uppercase small text-secondary mb-2">Voice Codex</p>
        <h1 class="h3 mb-3">Pair a controller</h1>
      </div>

      <img
        v-if="session?.pairing.qrDataUrl"
        class="pairing-qr"
        :src="session.pairing.qrDataUrl"
        alt="Pairing QR code"
      />

      <div v-if="session?.pairing.controllerUrl" class="pairing-url">
        {{ session.pairing.controllerUrl }}
      </div>

      <form v-if="session?.pairing.controllerUrl" class="qr-host-form" @submit.prevent="refreshPairingQr">
        <label class="form-label mb-1" for="qr-host">QR host</label>
        <div class="input-group">
          <input id="qr-host" v-model="qrHostInput" class="form-control" autocomplete="off" />
          <button class="btn btn-outline-light" type="submit">Update</button>
        </div>
      </form>

      <div v-else class="alert alert-secondary mb-0">
        Open <code>{{ session?.pairing.qrDisplayUrl }}</code> on the server host to display the
        pairing QR code.
      </div>

      <div v-if="errorMessage" class="alert alert-danger mb-0">{{ errorMessage }}</div>
    </section>
  </main>

  <main v-else class="app-shell">
    <nav class="topbar" aria-label="Codex threads">
      <div class="thread-tabs">
        <button
          v-for="thread in threads"
          :key="thread.id"
          type="button"
          class="thread-tab"
          :class="{ active: thread.id === activeThreadId }"
          @click="chooseThread(thread.id)"
        >
          <span>{{ thread.name }}</span>
          <i v-if="thread.state === 'running'" class="bi bi-circle-fill" aria-hidden="true"></i>
          <i v-else-if="thread.state === 'error'" class="bi bi-exclamation-circle-fill" aria-hidden="true"></i>
        </button>
        <span v-if="threads.length === 0" class="empty-tabs">No threads</span>
      </div>
      <div class="topbar-actions">
        <button class="icon-button" type="button" aria-label="New Codex thread" @click="openFolderPicker">
          <i class="bi bi-plus-lg" aria-hidden="true"></i>
        </button>
        <button class="icon-button" type="button" aria-label="Settings" @click="settingsOpen = true">
          <i class="bi bi-gear-fill" aria-hidden="true"></i>
        </button>
      </div>
    </nav>

    <section class="terminal-area" :aria-label="activeThread?.name ?? 'Codex terminal'">
      <div ref="terminalElement" class="terminal-container"></div>

      <div v-if="touchOverlayEnabled" class="touch-overlay" aria-label="Terminal touch controls">
        <div class="touch-zone touch-number-row">
          <button class="touch-key touch-key-small" type="button" aria-label="1" @click="sendTerminal('1')">1</button>
          <button class="touch-key touch-key-small" type="button" aria-label="2" @click="sendTerminal('2')">2</button>
          <button class="touch-key touch-key-small" type="button" aria-label="3" @click="sendTerminal('3')">3</button>
          <button class="touch-key touch-key-small" type="button" aria-label="4" @click="sendTerminal('4')">4</button>
        </div>

        <div class="touch-zone touch-left-controls">
          <div class="touch-dpad">
            <span aria-hidden="true"></span>
            <button class="touch-key" type="button" aria-label="Up" @click="sendTerminal('\u001b[A')">
              <i class="bi bi-arrow-up" aria-hidden="true"></i>
            </button>
            <span aria-hidden="true"></span>
            <button class="touch-key" type="button" aria-label="Left" @click="sendTerminal('\u001b[D')">
              <i class="bi bi-arrow-left" aria-hidden="true"></i>
            </button>
            <span aria-hidden="true"></span>
            <button class="touch-key" type="button" aria-label="Right" @click="sendTerminal('\u001b[C')">
              <i class="bi bi-arrow-right" aria-hidden="true"></i>
            </button>
            <span aria-hidden="true"></span>
            <button class="touch-key" type="button" aria-label="Down" @click="sendTerminal('\u001b[B')">
              <i class="bi bi-arrow-down" aria-hidden="true"></i>
            </button>
            <span aria-hidden="true"></span>
          </div>
          <button
            class="touch-key touch-ptt"
            :class="{ pressed: overlayPtt === 'whisper' }"
            type="button"
            @pointerdown.prevent="handleOverlayPttDown('whisper', $event)"
            @pointerup.prevent="handleOverlayPttUp('whisper', $event)"
            @pointercancel.prevent="handleOverlayPttUp('whisper', $event)"
            @lostpointercapture="releaseOverlayPtt"
          >
            <i class="bi bi-keyboard" aria-hidden="true"></i>
            Whisper
          </button>
        </div>

        <div class="touch-zone touch-center-controls">
          <button class="touch-key touch-key-small touch-tab-key" type="button" aria-label="Tab" @click="sendTerminal('\t')">
            Tab
          </button>
          <button class="touch-key touch-key-small touch-slash-key" type="button" aria-label="Slash" @click="sendTerminal('/')">
            /
          </button>
          <button class="touch-key touch-key-small touch-dollar-key" type="button" aria-label="Dollar sign" @click="sendTerminal('$')">
            $
          </button>
          <button
            class="touch-key touch-key-small touch-bksp-key"
            type="button"
            aria-label="Backspace"
            @click="sendTerminal('\u007f')"
          >
            Bksp
          </button>
          <button class="touch-key touch-key-small touch-space-key" type="button" aria-label="Space" @click="sendTerminal(' ')">
            Space
          </button>
          <button
            class="touch-key touch-key-small touch-paste-key"
            type="button"
            aria-label="Paste clipboard"
            @click="pasteClipboardToTerminal"
          >
            <i class="bi bi-clipboard" aria-hidden="true"></i>
          </button>
        </div>

        <div class="touch-zone touch-right-controls">
          <div class="touch-command-row">
            <button class="touch-key touch-key-text" type="button" aria-label="Enter" @click="sendTerminal('\r')">
              Enter
            </button>
            <button class="touch-key touch-key-text" type="button" aria-label="Escape" @click="sendTerminal('\u001b')">
              Esc
            </button>
          </div>
          <button
            class="touch-key touch-ptt"
            :class="{ pressed: overlayPtt === 'agent' }"
            type="button"
            @pointerdown.prevent="handleOverlayPttDown('agent', $event)"
            @pointerup.prevent="handleOverlayPttUp('agent', $event)"
            @pointercancel.prevent="handleOverlayPttUp('agent', $event)"
            @lostpointercapture="releaseOverlayPtt"
          >
            <i class="bi bi-mic-fill" aria-hidden="true"></i>
            Agent
          </button>
        </div>
      </div>

      <div v-if="pendingProposals.length > 0" class="proposal-overlay">
        <article v-for="proposal in pendingProposals" :key="proposal.id" class="proposal">
          <div class="proposal-meta">
            <strong>{{ proposal.threadName }}</strong>
            <span>{{ proposal.reason }}</span>
          </div>
          <pre>{{ proposal.displayText || proposal.keystrokes.join(" ") }}</pre>
          <div class="proposal-actions">
            <button class="btn btn-success btn-sm" type="button" @click="approveProposal(proposal)">
              <i class="bi bi-check-lg" aria-hidden="true"></i>
              Approve
            </button>
            <button class="btn btn-outline-light btn-sm" type="button" @click="rejectProposal(proposal)">
              <i class="bi bi-x-lg" aria-hidden="true"></i>
              Reject
            </button>
          </div>
        </article>
      </div>

      <div v-if="activeSummaryToasts.length > 0" class="summary-overlay" aria-live="polite">
        <article
          v-for="toast in activeSummaryToasts"
          :key="toast.id"
          class="turn-summary"
          :class="{ dragging: toast.dragging, leaving: toast.leaving }"
          :style="summaryToastStyle(toast)"
          @pointerdown="startSummaryToastSwipe(toast, $event)"
          @pointermove="updateSummaryToastSwipe(toast, $event)"
          @pointerup="finishSummaryToastSwipe(toast, $event)"
          @pointercancel="finishSummaryToastSwipe(toast, $event)"
        >
          <div class="summary-meta">
            <strong>{{ toast.summary.threadName }}</strong>
            <span>{{ toast.summary.status || "Turn summary" }}</span>
          </div>
          <p>{{ toast.summary.summary }}</p>
        </article>
      </div>
    </section>

    <div v-if="folderPickerOpen" class="modal-layer" role="dialog" aria-modal="true">
      <section class="app-modal folder-modal">
        <header class="modal-header-row">
          <div>
            <h2 class="modal-title">New Codex Thread</h2>
            <p class="modal-subtitle">{{ directoryListing?.current }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="Close" @click="folderPickerOpen = false">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </header>

        <div class="folder-actions">
          <button
            class="btn btn-outline-light btn-sm"
            type="button"
            :disabled="!directoryListing?.parent"
            @click="directoryListing?.parent && loadDirectory(directoryListing.parent)"
          >
            <i class="bi bi-arrow-up" aria-hidden="true"></i>
            Up
          </button>
          <button class="btn btn-primary btn-sm" type="button" :disabled="!directoryListing" @click="createNewThread">
            Start Here
          </button>
        </div>

        <div class="folder-list">
          <button
            v-for="entry in directoryListing?.entries ?? []"
            :key="entry.path"
            class="folder-row"
            type="button"
            @click="loadDirectory(entry.path)"
          >
            <i class="bi bi-folder-fill" aria-hidden="true"></i>
            <span>{{ entry.name }}</span>
          </button>
          <div v-if="directoryListing && directoryListing.entries.length === 0" class="empty-state">
            No child directories
          </div>
        </div>

        <form class="new-folder-form" @submit.prevent="createFolder">
          <input v-model="newDirectoryName" class="form-control" placeholder="New folder name" />
          <button class="btn btn-outline-light" type="submit">Create</button>
        </form>
      </section>
    </div>

    <div v-if="imageModalRequest" class="modal-layer image-modal-layer" role="dialog" aria-modal="true">
      <section class="app-modal image-modal">
        <header class="modal-header-row">
          <div>
            <h2 class="modal-title">{{ imageModalRequest.title || imageModalImage?.name || "Images" }}</h2>
            <p class="modal-subtitle">{{ imageModalRequest.threadName }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="Close images" @click="closeImageModal">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </header>

        <div class="image-stage">
          <img
            v-if="imageModalImage"
            :src="imageModalImage.url"
            :alt="imageModalImage.name"
          />
        </div>

        <div class="image-modal-footer">
          <button
            class="btn btn-outline-light btn-sm"
            type="button"
            :disabled="imageModalIndex <= 0"
            @click="selectImageModalIndex(imageModalIndex - 1)"
          >
            <i class="bi bi-chevron-left" aria-hidden="true"></i>
            Previous
          </button>
          <span>{{ imageModalIndex + 1 }} / {{ imageModalRequest.images.length }}</span>
          <button
            class="btn btn-outline-light btn-sm"
            type="button"
            :disabled="imageModalIndex >= imageModalRequest.images.length - 1"
            @click="selectImageModalIndex(imageModalIndex + 1)"
          >
            Next
            <i class="bi bi-chevron-right" aria-hidden="true"></i>
          </button>
        </div>

        <p v-if="imageModalRequest.caption" class="image-caption">
          {{ imageModalRequest.caption }}
        </p>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-layer" role="dialog" aria-modal="true">
      <section class="app-modal settings-modal">
        <header class="modal-header-row">
          <h2 class="modal-title">Controls</h2>
          <button class="icon-button" type="button" aria-label="Close" @click="settingsOpen = false">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </header>

        <div class="modal-scroll-body">
          <div class="binding-row">
            <span>Agent PTT</span>
            <button class="btn btn-outline-light btn-sm" type="button" @click="captureBinding = 'agent'">
              {{ captureBinding === "agent" ? "Press key" : bindings.agent }}
            </button>
          </div>
          <div class="binding-row">
            <span>Whisper PTT</span>
            <button class="btn btn-outline-light btn-sm" type="button" @click="captureBinding = 'whisper'">
              {{ captureBinding === "whisper" ? "Press key" : bindings.whisper }}
            </button>
          </div>
          <div class="binding-row">
            <span>Enter/Esc</span>
            <button class="btn btn-outline-light btn-sm" type="button" @click="captureBinding = 'action'">
              {{ captureBinding === "action" ? "Press key" : bindings.action }}
            </button>
          </div>
          <label class="touch-toggle">
            <span>Touch overlay</span>
            <input
              v-model="touchOverlayEnabled"
              class="form-check-input"
              type="checkbox"
              @change="saveTouchOverlayEnabled"
            />
          </label>
          <label class="touch-toggle">
            <span>Always listen</span>
            <input
              v-model="alwaysListening"
              class="form-check-input"
              type="checkbox"
              @change="onAlwaysListeningChange"
            />
          </label>
          <label class="touch-toggle">
            <span>AI-generated spoken summaries</span>
            <input
              v-model="spokenSummariesEnabled"
              class="form-check-input"
              type="checkbox"
              @change="saveSpokenSummariesEnabled"
            />
          </label>
          <button class="btn btn-outline-light w-100" type="button" @click="toggleFullscreen">
            <i class="bi bi-arrows-fullscreen" aria-hidden="true"></i>
            {{ fullscreenActive ? "Exit Fullscreen" : "Enter Fullscreen" }}
          </button>
        </div>
      </section>
    </div>

    <div
      v-if="pendingClipboardCopy"
      class="clipboard-copy-prompt"
      role="status"
      aria-live="polite"
    >
      <div class="clipboard-copy-text">
        <strong>Clipboard copy</strong>
        <span>{{ pendingClipboardCopy.message }}</span>
      </div>
      <button class="btn btn-primary btn-sm" type="button" @click="copyPendingClipboardText">
        Copy
      </button>
      <button class="btn btn-outline-light btn-sm" type="button" @click="dismissPendingClipboardCopy">
        Dismiss
      </button>
    </div>

    <div v-if="errorMessage" class="toast-error alert alert-danger">
      {{ errorMessage }}
      <button class="btn-close" type="button" aria-label="Close" @click="errorMessage = ''"></button>
    </div>
  </main>
</template>
