import type {
  CodexThreadSummary,
  DirectoryListing,
  KeystrokeProposal,
  SessionResponse,
  TerminalSnapshotEvent
} from "@shared/protocol";

export async function getSession(pairHost?: string): Promise<SessionResponse> {
  const params = new URLSearchParams();
  if (pairHost?.trim()) {
    params.set("pairHost", pairHost.trim());
  }

  return request<SessionResponse>(`/api/session${params.size ? `?${params}` : ""}`);
}

export async function pair(token: string): Promise<void> {
  await request("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
}

export async function listThreads(): Promise<{
  threads: CodexThreadSummary[];
  activeThreadId?: string;
}> {
  return request("/api/threads");
}

export async function createThread(input: {
  name?: string;
  cwd: string;
}): Promise<{ thread: CodexThreadSummary }> {
  return request("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function browseDirectories(path?: string): Promise<{ listing: DirectoryListing }> {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }

  return request(`/api/fs/directories${params.size ? `?${params}` : ""}`);
}

export async function createDirectory(input: {
  parentPath: string;
  name: string;
}): Promise<{ listing: DirectoryListing }> {
  return request("/api/fs/directories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function selectThread(threadId: string): Promise<{ thread: CodexThreadSummary }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/select`, {
    method: "POST"
  });
}

export async function stopThread(threadId: string): Promise<{ thread: CodexThreadSummary }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/stop`, {
    method: "POST"
  });
}

export async function readTerminal(
  threadId: string,
  lines = 80
): Promise<{ threadId: string; text: string }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/read?lines=${lines}`);
}

export async function getTerminalSnapshot(
  threadId: string
): Promise<TerminalSnapshotEvent> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/snapshot`);
}

export async function createProposal(input: {
  threadId: string;
  keystrokes: string[];
  displayText: string;
  reason: string;
}): Promise<{ proposal: KeystrokeProposal }> {
  return request("/api/proposals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function resolveProposal(
  proposalId: string,
  decision: "approve" | "reject"
): Promise<{ proposal: KeystrokeProposal }> {
  return request(`/api/proposals/${encodeURIComponent(proposalId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision })
  });
}

export async function updateProposal(input: {
  proposalId: string;
  displayText: string;
  keystrokes: string[];
  reason?: string;
}): Promise<{ proposal: KeystrokeProposal }> {
  return request(`/api/proposals/${encodeURIComponent(input.proposalId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayText: input.displayText,
      keystrokes: input.keystrokes,
      reason: input.reason
    })
  });
}

export async function transcribe(audio: Blob): Promise<{ text: string }> {
  const form = new FormData();
  form.set("audio", audio, "speech.webm");
  return request("/api/transcribe", {
    method: "POST",
    body: form
  });
}

export async function createRealtimeAnswer(offerSdp: string): Promise<string> {
  const response = await fetch("/api/realtime/session", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/sdp" },
    body: offerSdp
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? `Realtime session failed with HTTP ${response.status}`);
    }
    const text = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 280);
    throw new Error(text || `Realtime session failed with HTTP ${response.status}`);
  }

  return response.text();
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "include"
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    throw new Error(await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
