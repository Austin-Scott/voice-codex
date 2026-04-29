import { randomUUID } from "node:crypto";

export const SESSION_COOKIE = "voice_codex_session";

export class PairingManager {
  private token = randomUUID();
  private activeSessionId: string | undefined;

  getToken(): string {
    return this.token;
  }

  hasController(): boolean {
    return Boolean(this.activeSessionId);
  }

  isController(sessionId: string | undefined): boolean {
    return Boolean(sessionId && this.activeSessionId === sessionId);
  }

  pair(token: string): string | undefined {
    if (token !== this.token) {
      return undefined;
    }

    this.activeSessionId = randomUUID();
    this.token = randomUUID();
    return this.activeSessionId;
  }
}
