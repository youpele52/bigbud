import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeRemoteAgentAdmission,
  getRemoteAgentAdmissionRequestId,
} from "./remoteAgentAdmissionRequest";

describe("remote agent admission request identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an unresolved ID across component remounts and rotates only after success", () => {
    const target = `ssh:request-identity-${crypto.randomUUID()}`;
    const first = getRemoteAgentAdmissionRequestId(target);
    expect(getRemoteAgentAdmissionRequestId(target)).toBe(first);
    completeRemoteAgentAdmission(target, "different-request");
    expect(getRemoteAgentAdmissionRequestId(target)).toBe(first);
    completeRemoteAgentAdmission(target, first);
    expect(getRemoteAgentAdmissionRequestId(target)).not.toBe(first);
  });

  it("survives a renderer remount through localStorage", () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    vi.stubGlobal("window", { localStorage });
    const target = `ssh:local-storage-${crypto.randomUUID()}`;
    const first = getRemoteAgentAdmissionRequestId(target);
    vi.stubGlobal("window", { localStorage });
    expect(getRemoteAgentAdmissionRequestId(target)).toBe(first);
  });
});
