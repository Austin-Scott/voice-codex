import type { ClientEvent, ServerEvent } from "@shared/protocol";

export class VoiceCodexSocket {
  private socket: WebSocket | undefined;

  constructor(
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onStatus: (status: "open" | "closed") => void,
    private readonly onError: (message: string) => void
  ) {}

  connect(): void {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${scheme}://${window.location.host}/ws`);

    this.socket.addEventListener("open", () => this.onStatus("open"));
    this.socket.addEventListener("close", () => this.onStatus("closed"));
    this.socket.addEventListener("error", () => this.onError("WebSocket connection failed"));
    this.socket.addEventListener("message", (message) => {
      try {
        this.onEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        this.onError("Received invalid WebSocket event");
      }
    });
  }

  send(event: ClientEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  close(): void {
    this.socket?.close();
  }
}
