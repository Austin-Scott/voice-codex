export type ThreadState = "starting" | "running" | "exited" | "error";

export interface CodexThreadSummary {
  id: string;
  name: string;
  cwd: string;
  state: ThreadState;
  active: boolean;
  exitCode?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PairingInfo {
  controllerUrl?: string;
  qrDataUrl?: string;
  qrDisplayUrl: string;
  localControllerUrl?: string;
}

export interface SessionResponse {
  paired: boolean;
  isController: boolean;
  pairing: PairingInfo;
  activeThreadId?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  root: string;
  current: string;
  parent?: string;
  entries: DirectoryEntry[];
}

export type TerminalKeyToken =
  | "<ENTER>"
  | "<ESC>"
  | "<TAB>"
  | "<SPACE>"
  | "<SHIFT_TAB>"
  | "<BACKSPACE>"
  | "<CTRL_C>"
  | "<CTRL_J>"
  | "<UP>"
  | "<DOWN>"
  | "<LEFT>"
  | "<RIGHT>"
  | string;

export interface KeystrokeProposal {
  id: string;
  threadId: string;
  threadName: string;
  keystrokes: TerminalKeyToken[];
  displayText: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
}

export interface TurnSummary {
  id: string;
  threadId: string;
  threadName: string;
  summary: string;
  status?: string;
  createdAt: string;
}

export interface ControllerImage {
  id: string;
  threadId: string;
  threadName: string;
  name: string;
  path: string;
  mimeType: string;
  url: string;
}

export interface ImageModalRequest {
  id: string;
  threadId: string;
  threadName: string;
  title?: string;
  caption?: string;
  images: ControllerImage[];
  createdAt: string;
}

export interface TerminalFramePayload {
  threadId: string;
  sequence: number;
  cols: number;
  rows: number;
  data: string;
  plainText: string;
}

export interface TerminalSnapshotEvent extends TerminalFramePayload {
  type: "terminal.snapshot";
}

export interface TerminalFrameEvent extends TerminalFramePayload {
  type: "terminal.frame";
}

export interface TerminalDeltaEvent {
  type: "terminal.delta";
  threadId: string;
  data: string;
}

export interface ThreadStatusEvent {
  type: "thread.status";
  thread: CodexThreadSummary;
}

export interface ThreadsEvent {
  type: "threads";
  threads: CodexThreadSummary[];
  activeThreadId?: string;
}

export interface ProposalCreatedEvent {
  type: "proposal.created";
  proposal: KeystrokeProposal;
}

export interface ProposalResolvedEvent {
  type: "proposal.resolved";
  proposal: KeystrokeProposal;
}

export interface ProposalUpdatedEvent {
  type: "proposal.updated";
  proposal: KeystrokeProposal;
}

export interface ProposalsEvent {
  type: "proposals";
  proposals: KeystrokeProposal[];
}

export interface TurnSummaryCreatedEvent {
  type: "turn_summary.created";
  summary: TurnSummary;
}

export interface TurnSummariesEvent {
  type: "turn_summaries";
  summaries: TurnSummary[];
}

export interface ImageModalOpenEvent {
  type: "image_modal.open";
  request: ImageModalRequest;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ServerEvent =
  | TerminalSnapshotEvent
  | TerminalFrameEvent
  | TerminalDeltaEvent
  | ThreadStatusEvent
  | ThreadsEvent
  | ProposalCreatedEvent
  | ProposalResolvedEvent
  | ProposalUpdatedEvent
  | ProposalsEvent
  | TurnSummaryCreatedEvent
  | TurnSummariesEvent
  | ImageModalOpenEvent
  | ErrorEvent;

export type ClientEvent =
  | { type: "terminal.input"; threadId: string; data: string }
  | { type: "terminal.resize"; threadId: string; cols: number; rows: number }
  | { type: "thread.select"; threadId: string }
  | { type: "thread.create"; name?: string; cwd: string }
  | { type: "thread.close"; threadId: string }
  | { type: "proposal.update"; proposalId: string; displayText: string; keystrokes: TerminalKeyToken[] }
  | { type: "proposal.approve"; proposalId: string }
  | { type: "proposal.reject"; proposalId: string };
