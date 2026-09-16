import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRemoteAgentEffect } from "./wsRemoteAgentAdmission.ts";
import { remoteAgentAdmission } from "../remote-agent/remoteAgentAdmission.ts";
import type { RemoteAgentUpdateCoordinatorShape } from "../remote-agent/remoteAgentUpdate.coordinator.ts";

vi.mock("../remote-agent/remoteAgentServerLayer.ts", () => ({
  isRemoteAgentConfigured: () => true,
}));
vi.mock("../remote-agent/remoteAgentInstall.maintenance.ts", () => ({
  scheduleRemoteAgentCleanup: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
const input = {
  executionTargetId: "ssh:host=fixture&transport=agent",
  requestId: "same-request",
  intent: "fresh" as const,
};

describe("remote agent explicit connection RPC", () => {
  it("passes the connection-specific update warning into durable admission", async () => {
    const preparation = { warning: "Release metadata unavailable.", requestedVersion: "0.2.209" };
    const prepareForAdmission = vi.fn(async () => preparation);
    const fresh = vi
      .spyOn(remoteAgentAdmission, "fresh")
      .mockImplementation(async (_target, _id, prepare) => {
        expect(typeof prepare).toBe("function");
        expect(await (prepare as () => Promise<unknown>)()).toEqual(preparation);
        throw new Error("admission probe");
      });
    await expect(
      Effect.runPromise(
        connectRemoteAgentEffect(input, {
          prepareForAdmission,
        } as unknown as RemoteAgentUpdateCoordinatorShape),
      ),
    ).rejects.toThrow("admission probe");
    expect(fresh).toHaveBeenCalledWith(
      input.executionTargetId,
      input.requestId,
      expect.any(Function),
    );
  });

  it("waits for readiness before admitting the same request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareForAdmission = vi.fn(() => gate);
    const admitted = vi.fn();
    const fresh = vi
      .spyOn(remoteAgentAdmission, "fresh")
      .mockImplementation(async (_target, _id, prepare) => {
        await (prepare as () => Promise<unknown>)();
        admitted();
        throw new Error("admission probe");
      });
    const coordinator = { prepareForAdmission } as unknown as RemoteAgentUpdateCoordinatorShape;
    const pending = Effect.runPromise(connectRemoteAgentEffect(input, coordinator));
    const result = expect(pending).rejects.toThrow("admission probe");
    await vi.waitFor(() =>
      expect(prepareForAdmission).toHaveBeenCalledWith(input.executionTargetId, input.requestId),
    );
    expect(admitted).not.toHaveBeenCalled();
    release();
    await result;
    expect(fresh).toHaveBeenCalledWith(
      input.executionTargetId,
      input.requestId,
      expect.any(Function),
    );
    expect(admitted).toHaveBeenCalledOnce();
  });

  it("reports preparation failure with manual SSH guidance and never attempts admission", async () => {
    const admitted = vi.fn();
    vi.spyOn(remoteAgentAdmission, "fresh").mockImplementation(async (_target, _id, prepare) => {
      await (prepare as () => Promise<unknown>)();
      admitted();
      throw new Error("should not admit");
    });
    const prepareForAdmission = vi
      .fn()
      .mockRejectedValue(new Error("Supervisor handshake timed out"));
    await expect(
      Effect.runPromise(
        connectRemoteAgentEffect(input, {
          prepareForAdmission,
        } as unknown as RemoteAgentUpdateCoordinatorShape),
      ),
    ).rejects.toThrow(
      "Supervisor handshake timed out. You can switch Connection method to Direct SSH",
    );
    expect(admitted).not.toHaveBeenCalled();
    expect(input.executionTargetId).toContain("transport=agent");
  });

  it("rejects an explicitly Direct SSH target before agent preparation", async () => {
    const prepareForAdmission = vi.fn();
    await expect(
      Effect.runPromise(
        connectRemoteAgentEffect(
          { ...input, executionTargetId: "ssh:host=fixture&transport=direct-ssh" },
          { prepareForAdmission } as unknown as RemoteAgentUpdateCoordinatorShape,
        ),
      ),
    ).rejects.toThrow("This project uses Direct SSH");
    expect(prepareForAdmission).not.toHaveBeenCalled();
  });
});
