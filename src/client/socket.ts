import type { ClientEvent, ServerEvent } from "@shared/protocol";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

export class VoiceCodexSocket {
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof window.setTimeout> | undefined;
  private reconnectAttempts = 0;
  private closedByClient = false;

  constructor(
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onStatus: (status: "open" | "closed") => void,
    private readonly onError: (message: string) => void
  ) {}

  connect(): void {
    this.closedByClient = false;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.clearReconnectTimer();
    this.openSocket();
  }

  reconnectNow(): void {
    this.closedByClient = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();

    const current = this.socket;
    this.socket = undefined;
    if (current && current.readyState !== WebSocket.CLOSED) {
      current.close();
    }

    this.openSocket();
  }

  send(event: ClientEvent): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
      return true;
    }

    this.connect();
    return false;
  }

  close(): void {
    this.closedByClient = true;
    this.clearReconnectTimer();

    const current = this.socket;
    this.socket = undefined;
    if (current && current.readyState !== WebSocket.CLOSED) {
      current.close();
    }
    this.onStatus("closed");
  }

  private openSocket(): void {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }
      this.reconnectAttempts = 0;
      this.onStatus("open");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.onStatus("closed");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.onStatus("closed");
      try {
        socket.close();
      } catch {
        // The reconnect timer below handles failed or already-closing sockets.
      }
      this.scheduleReconnect();
    });
    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) {
        return;
      }
      try {
        this.onEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        this.onError("Received invalid WebSocket event");
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByClient || this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closedByClient) {
        this.openSocket();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
