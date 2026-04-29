import crypto from "node:crypto";

export const SESSION_COOKIE = "voice_codex_session";

export class PairingManager {
  private pin = createPin();
  private activeSessionId: string | undefined;

  getPin(): string {
    return this.pin;
  }

  hasController(): boolean {
    return Boolean(this.activeSessionId);
  }

  isController(sessionId: string | undefined): boolean {
    return Boolean(sessionId && this.activeSessionId === sessionId);
  }

  pair(pin: string): string | undefined {
    if (pin.replace(/\D/g, "") !== this.pin) {
      return undefined;
    }

    this.activeSessionId = crypto.randomUUID();
    this.pin = createPin();
    return this.activeSessionId;
  }
}

function createPin(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}
