import { describe, expect, it } from "vitest";
import { PairingManager } from "../src/server/pairing";

describe("PairingManager", () => {
  it("accepts the active PIN and marks the new controller session", () => {
    const pairing = new PairingManager();
    const sessionId = pairing.pair(pairing.getPin());

    expect(sessionId).toBeTruthy();
    expect(pairing.hasController()).toBe(true);
    expect(pairing.isController(sessionId)).toBe(true);
  });

  it("rejects a bad PIN", () => {
    const pairing = new PairingManager();

    expect(pairing.pair("not-the-pin")).toBeUndefined();
    expect(pairing.hasController()).toBe(false);
  });

  it("revokes the old controller when a new browser pairs", () => {
    const pairing = new PairingManager();
    const first = pairing.pair(pairing.getPin());
    const second = pairing.pair(pairing.getPin());

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(pairing.isController(first)).toBe(false);
    expect(pairing.isController(second)).toBe(true);
  });
});
