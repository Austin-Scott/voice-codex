<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type {
  CodexThreadSummary,
  DirectoryListing,
  KeystrokeProposal,
  ServerEvent,
  SessionResponse
} from "@shared/protocol";
import {
  browseDirectories,
  createDirectory,
  createThread,
  getSession,
  listThreads,
  pair,
  resolveProposal,
  selectThread,
  stopThread,
  transcribe
} from "./api";
import {
  DEFAULT_PEDAL_BINDINGS,
  DEFAULT_TOUCH_MAPPINGS,
  PedalInput,
  TouchButtonInput,
  type TouchPoint,
  type PedalBindings,
  type PedalHandlers,
  type TouchMappings
} from "./pedal";
import { RealtimeVoiceAgent } from "./realtime";
import { VoiceCodexSocket } from "./socket";

const session = ref<SessionResponse | undefined>();
const errorMessage = ref("");
const statusMessage = ref("Loading");
const wsStatus = ref<"open" | "closed">("closed");
const agentStatus = ref("Voice agent idle");
const whisperStatus = ref("Whisper idle");
const threads = ref<CodexThreadSummary[]>([]);
const activeThreadId = ref<string | undefined>();
const proposals = ref<KeystrokeProposal[]>([]);
const terminalElement = ref<HTMLDivElement | null>(null);
const captureBinding = ref<keyof PedalBindings | undefined>();
const qrHostInput = ref("");
const settingsOpen = ref(false);
const folderPickerOpen = ref(false);
const directoryListing = ref<DirectoryListing | undefined>();
const newDirectoryName = ref("");
const touchControlsEnabled = ref(loadTouchControlsEnabled());
const touchMappings = reactive<TouchMappings>(loadTouchMappings());
const bindings = reactive<PedalBindings>(loadPedalBindings());

let socket: VoiceCodexSocket | undefined;
let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let pedal: PedalInput | undefined;
let touchInput: TouchButtonInput | undefined;
let voiceAgent: RealtimeVoiceAgent | undefined;
let agentPressed = false;
let whisperRecorder: MediaRecorder | undefined;
let whisperStream: MediaStream | undefined;
let whisperChunks: Blob[] = [];

const isController = computed(() => Boolean(session.value?.isController));
const activeThread = computed(() => threads.value.find((thread) => thread.id === activeThreadId.value));
const pendingProposals = computed(() =>
  proposals.value.filter((proposal) => proposal.status === "pending")
);

onMounted(async () => {
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("keyup", handleKeyUp, true);
  await loadSession();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeyDown, true);
  window.removeEventListener("keyup", handleKeyUp, true);
  resizeObserver?.disconnect();
  pedal?.dispose();
  touchInput?.dispose();
  voiceAgent?.disconnect();
  socket?.close();
  terminalElement.value?.removeEventListener("touchstart", handleTouchStart);
  terminalElement.value?.removeEventListener("touchmove", handleTouchMove);
  terminalElement.value?.removeEventListener("touchend", handleTouchEnd);
  terminalElement.value?.removeEventListener("touchcancel", handleTouchCancel);
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
  setupTouchInput();
  connectSocket();
  await nextTick();
  setupTerminal();
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
      setActiveThread: (threadId) => {
        activeThreadId.value = threadId;
        requestSnapshot(threadId);
      }
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
      agentPressed = true;
      void startAgentPushToTalk();
    },
    onAgentUp: () => {
      agentPressed = false;
      voiceAgent?.setListening(false);
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

function setupTouchInput(): void {
  touchInput?.dispose();
  touchInput = new TouchButtonInput(
    {
      onAgentDown: () => {
        agentPressed = true;
        void startAgentPushToTalk();
      },
      onAgentUp: () => {
        agentPressed = false;
        voiceAgent?.setListening(false);
      },
      onWhisperDown: () => {
        void startWhisper();
      },
      onWhisperUp: () => {
        void stopWhisper();
      },
      onActionEnter: () => sendTerminal("\r"),
      onActionEsc: () => sendTerminal("\u001b")
    },
    { ...touchMappings }
  );
}

function connectSocket(): void {
  socket?.close();
  socket = new VoiceCodexSocket(
    handleServerEvent,
    (status) => {
      wsStatus.value = status;
      if (status === "open" && activeThreadId.value) {
        requestSnapshot(activeThreadId.value);
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
  terminalElement.value.addEventListener("touchstart", handleTouchStart, { passive: false });
  terminalElement.value.addEventListener("touchmove", handleTouchMove, { passive: false });
  terminalElement.value.addEventListener("touchend", handleTouchEnd, { passive: false });
  terminalElement.value.addEventListener("touchcancel", handleTouchCancel, { passive: false });
  fitAddon.fit();
}

function handleServerEvent(event: ServerEvent): void {
  if (event.type === "threads") {
    threads.value = event.threads;
    activeThreadId.value = event.activeThreadId;
    return;
  }

  if (event.type === "thread.status") {
    upsertThread(event.thread);
    return;
  }

  if (event.type === "terminal.delta") {
    if (event.threadId === activeThreadId.value) {
      terminal?.write(event.data);
    }
    return;
  }

  if (event.type === "terminal.snapshot") {
    if (event.threadId === activeThreadId.value) {
      terminal?.reset();
      terminal?.write(event.data);
    }
    return;
  }

  if (event.type === "proposal.created") {
    upsertProposal(event.proposal);
    return;
  }

  if (event.type === "proposal.resolved") {
    upsertProposal(event.proposal);
    return;
  }

  if (event.type === "error") {
    errorMessage.value = event.message;
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
    requestSnapshot(response.thread.id);
    folderPickerOpen.value = false;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
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
    requestSnapshot(threadId);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function stopSelectedThread(): Promise<void> {
  if (!activeThreadId.value) {
    return;
  }
  try {
    const response = await stopThread(activeThreadId.value);
    upsertThread(response.thread);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function approveProposal(proposal: KeystrokeProposal): Promise<void> {
  const response = await resolveProposal(proposal.id, "approve");
  upsertProposal(response.proposal);
}

async function rejectProposal(proposal: KeystrokeProposal): Promise<void> {
  const response = await resolveProposal(proposal.id, "reject");
  upsertProposal(response.proposal);
}

function requestSnapshot(threadId: string): void {
  socket?.send({ type: "thread.select", threadId });
}

function sendTerminal(data: string): void {
  if (!activeThreadId.value) {
    errorMessage.value = "Create or select a Codex thread first.";
    return;
  }
  socket?.send({ type: "terminal.input", threadId: activeThreadId.value, data });
}

async function startAgentPushToTalk(): Promise<void> {
  try {
    await voiceAgent?.ensureConnected();
    if (agentPressed) {
      voiceAgent?.setListening(true);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
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

function handleTouchStart(event: TouchEvent): void {
  if (!touchControlsEnabled.value || !touchInput) {
    return;
  }

  const started = touchInput.start(toTouchPoints(event.touches));
  if (started && event.touches.length === 3) {
    event.preventDefault();
  }
}

function handleTouchMove(event: TouchEvent): void {
  if (!touchControlsEnabled.value || !touchInput) {
    return;
  }

  if (touchInput.move(toTouchPoints(event.touches))) {
    event.preventDefault();
  }
}

function handleTouchEnd(event: TouchEvent): void {
  if (!touchControlsEnabled.value || !touchInput) {
    return;
  }

  if (event.touches.length === 0 && touchInput.end()) {
    event.preventDefault();
  }
}

function handleTouchCancel(): void {
  touchInput?.cancel();
}

function upsertThread(thread: CodexThreadSummary): void {
  const index = threads.value.findIndex((existing) => existing.id === thread.id);
  if (index >= 0) {
    threads.value.splice(index, 1, thread);
  } else {
    threads.value.push(thread);
  }
}

function upsertProposal(proposal: KeystrokeProposal): void {
  const index = proposals.value.findIndex((existing) => existing.id === proposal.id);
  if (index >= 0) {
    proposals.value.splice(index, 1, proposal);
  } else {
    proposals.value.unshift(proposal);
  }
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

function loadTouchControlsEnabled(): boolean {
  return window.localStorage.getItem("voice-codex-touch-controls") !== "false";
}

function saveTouchControlsEnabled(): void {
  window.localStorage.setItem("voice-codex-touch-controls", String(touchControlsEnabled.value));
}

function loadTouchMappings(): TouchMappings {
  const stored = window.localStorage.getItem("voice-codex-touch-mappings");
  if (!stored) {
    return { ...DEFAULT_TOUCH_MAPPINGS };
  }

  try {
    return normalizeTouchMappings(JSON.parse(stored) as Partial<TouchMappings>);
  } catch {
    return { ...DEFAULT_TOUCH_MAPPINGS };
  }
}

function setTouchMapping(kind: keyof TouchMappings, value: string): void {
  const next = Number(value);
  const previous = touchMappings[kind];
  const swappedKind = (Object.keys(touchMappings) as Array<keyof TouchMappings>).find(
    (candidate) => candidate !== kind && touchMappings[candidate] === next
  );

  touchMappings[kind] = next;
  if (swappedKind) {
    touchMappings[swappedKind] = previous;
  }

  saveTouchMappings();
}

function onTouchMappingChange(kind: keyof TouchMappings, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLSelectElement) {
    setTouchMapping(kind, target.value);
  }
}

function saveTouchMappings(): void {
  window.localStorage.setItem("voice-codex-touch-mappings", JSON.stringify(touchMappings));
  touchInput?.setMappings({ ...touchMappings });
}

function normalizeTouchMappings(input: Partial<TouchMappings>): TouchMappings {
  const values = [input.agent, input.whisper, input.action].map((value) => Number(value));
  const valid = values.every((value) => [1, 2, 3].includes(value)) && new Set(values).size === 3;
  if (!valid) {
    return { ...DEFAULT_TOUCH_MAPPINGS };
  }

  return {
    agent: values[0],
    whisper: values[1],
    action: values[2]
  };
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

function toTouchPoints(touches: TouchList): TouchPoint[] {
  return Array.from(touches).map((touch) => ({
    id: touch.identifier,
    x: touch.clientX,
    y: touch.clientY
  }));
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

    <div v-if="settingsOpen" class="modal-layer" role="dialog" aria-modal="true">
      <section class="app-modal settings-modal">
        <header class="modal-header-row">
          <h2 class="modal-title">Controls</h2>
          <button class="icon-button" type="button" aria-label="Close" @click="settingsOpen = false">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </header>

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
          <span>Touch controls</span>
          <input
            v-model="touchControlsEnabled"
            class="form-check-input"
            type="checkbox"
            @change="saveTouchControlsEnabled"
          />
        </label>
        <div class="touch-map-row">
          <label for="touch-agent">Agent PTT</label>
          <select
            id="touch-agent"
            class="form-select form-select-sm"
            :value="touchMappings.agent"
            @change="onTouchMappingChange('agent', $event)"
          >
            <option value="1">1 finger</option>
            <option value="2">2 fingers</option>
            <option value="3">3 fingers</option>
          </select>
        </div>
        <div class="touch-map-row">
          <label for="touch-whisper">Whisper PTT</label>
          <select
            id="touch-whisper"
            class="form-select form-select-sm"
            :value="touchMappings.whisper"
            @change="onTouchMappingChange('whisper', $event)"
          >
            <option value="1">1 finger</option>
            <option value="2">2 fingers</option>
            <option value="3">3 fingers</option>
          </select>
        </div>
        <div class="touch-map-row">
          <label for="touch-action">Enter/Esc</label>
          <select
            id="touch-action"
            class="form-select form-select-sm"
            :value="touchMappings.action"
            @change="onTouchMappingChange('action', $event)"
          >
            <option value="1">1 finger</option>
            <option value="2">2 fingers</option>
            <option value="3">3 fingers</option>
          </select>
        </div>
      </section>
    </div>

    <div v-if="errorMessage" class="toast-error alert alert-danger">
      {{ errorMessage }}
      <button class="btn-close" type="button" aria-label="Close" @click="errorMessage = ''"></button>
    </div>
  </main>
</template>
