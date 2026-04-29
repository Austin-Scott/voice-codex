import { describe, expect, it } from "vitest";
import { PairingManager } from "../src/server/pairing";

describe("PairingManager", () => {
  it("accepts the active token and marks the new controller session", () => {
    const pairing = new PairingManager();
    const sessionId = pairing.pair(pairing.getToken());

    expect(sessionId).toBeTruthy();
    expect(pairing.hasController()).toBe(true);
    expect(pairing.isController(sessionId)).toBe(true);
  });

  it("rejects a bad token", () => {
    const pairing = new PairingManager();

    expect(pairing.pair("not-the-token")).toBeUndefined();
    expect(pairing.hasController()).toBe(false);
  });

  it("revokes the old controller when a new browser pairs", () => {
    const pairing = new PairingManager();
    const first = pairing.pair(pairing.getToken());
    const second = pairing.pair(pairing.getToken());

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(pairing.isController(first)).toBe(false);
    expect(pairing.isController(second)).toBe(true);
  });

  it("uses UUID tokens", () => {
    const pairing = new PairingManager();

    expect(pairing.getToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
