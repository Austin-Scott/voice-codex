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
  | "<BACKSPACE>"
  | "<CTRL_C>"
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

export interface TerminalSnapshotEvent {
  type: "terminal.snapshot";
  threadId: string;
  data: string;
  plainText: string;
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

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ServerEvent =
  | TerminalSnapshotEvent
  | TerminalDeltaEvent
  | ThreadStatusEvent
  | ThreadsEvent
  | ProposalCreatedEvent
  | ProposalResolvedEvent
  | ProposalUpdatedEvent
  | ErrorEvent;

export type ClientEvent =
  | { type: "terminal.input"; threadId: string; data: string }
  | { type: "terminal.resize"; threadId: string; cols: number; rows: number }
  | { type: "thread.select"; threadId: string }
  | { type: "thread.create"; name?: string; cwd: string }
  | { type: "proposal.update"; proposalId: string; displayText: string; keystrokes: TerminalKeyToken[] }
  | { type: "proposal.approve"; proposalId: string }
  | { type: "proposal.reject"; proposalId: string };
