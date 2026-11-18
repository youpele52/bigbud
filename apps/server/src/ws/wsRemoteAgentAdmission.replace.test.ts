import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activateRemoteAgentFresh } from "../remote-agent/remoteAgentActivation.ts";
import { connectRemoteAgentEffect } from "./wsRemoteAgentAdmission.ts";

vi.mock("../remote-agent/remoteAgentServerLayer.ts", () => ({
  isRemoteAgentConfigured: () => true,
}));
vi.mock("../remote-agent/remoteAgentActivation.ts", () => ({
  activateRemoteAgentFresh: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const target = "ssh:host=fixture&transport=agent";
const input = { executionTargetId: target, requestId: "connect-1", intent: "fresh" as const };
const connected = (outcome: "selected" | "fallback" = "selected") => ({
  connectionId: "c1",
  currentVersion: "0.3.4",
  currentBuildId: "0.3.4:musl",
  pendingVersion: null,
  fallbackVersion: null,
  outcome,
});

function retirement(result: { cleanupDeferred: boolean; message: string | null } | null) {
  return { retireAfterActivation: vi.fn(async () => result) };
}

describe("app Connect after a staged Install retires older builds by default", () => {
  it("retires through the shared operations once the new build is active", async () => {
    vi.mocked(activateRemoteAgentFresh).mockResolvedValue(connected() as never);
    const operations = retirement({ cleanupDeferred: false, message: null });
    const result = await Effect.runPromise(
      connectRemoteAgentEffect({ ...input, replace: true }, undefined, operations),
    );
    expect(operations.retireAfterActivation).toHaveBeenCalledExactlyOnceWith(target);
    expect(result).toMatchObject({ currentVersion: "0.3.4", cleanupDeferred: false });
    expect(result.cleanupMessage).toBeUndefined();
  });

  it("reports the deferral notice while live work keeps an old build", async () => {
    vi.mocked(activateRemoteAgentFresh).mockResolvedValue(connected() as never);
    const message = "Cleanup of older builds is deferred while live work still uses them.";
    const result = await Effect.runPromise(
      connectRemoteAgentEffect(
        { ...input, replace: true },
        undefined,
        retirement({ cleanupDeferred: true, message }),
      ),
    );
    expect(result).toMatchObject({ cleanupDeferred: true, cleanupMessage: message });
  });

  it("never retires without replace, on a healthy fallback, or after a failed activation", async () => {
    const operations = retirement({ cleanupDeferred: false, message: null });
    vi.mocked(activateRemoteAgentFresh).mockResolvedValue(connected() as never);
    await Effect.runPromise(connectRemoteAgentEffect(input, undefined, operations));
    vi.mocked(activateRemoteAgentFresh).mockResolvedValue(connected("fallback") as never);
    await Effect.runPromise(
      connectRemoteAgentEffect({ ...input, replace: true }, undefined, operations),
    );
    vi.mocked(activateRemoteAgentFresh).mockRejectedValue(new Error("handshake refused"));
    await expect(
      Effect.runPromise(
        connectRemoteAgentEffect({ ...input, replace: true }, undefined, operations),
      ),
    ).rejects.toThrow("handshake refused");
    expect(operations.retireAfterActivation).not.toHaveBeenCalled();
  });

  it("keeps the connection when retirement itself throws", async () => {
    vi.mocked(activateRemoteAgentFresh).mockResolvedValue(connected() as never);
    const operations = {
      retireAfterActivation: vi.fn(async () => {
        throw new Error("registry unreadable");
      }),
    };
    const result = await Effect.runPromise(
      connectRemoteAgentEffect({ ...input, replace: true }, undefined, operations),
    );
    expect(result).toMatchObject({ connectionId: "c1", currentVersion: "0.3.4" });
    expect(result.cleanupDeferred).toBeUndefined();
  });
});
