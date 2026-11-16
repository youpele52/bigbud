import { afterEach, expect, it, vi } from "vitest";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners";
import { emptyRemoteAgentRegistry, type RemoteAgentRegistry } from "./remoteAgentInstall.registry";
import { remoteAgentBuildId } from "./remoteAgentRuntime";
import { profileOwner, spawnInput } from "./remoteAgentOwnedPty.profile.testUtils";

const fixture = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("./remoteAgentControl.ts", () => ({
  openRemoteAgentControl: async () => ({ registry: { update: fixture.update } }),
}));
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "failed initial recovery retires observers (deadline: %s)",
  async (deadline) => {
    const owner = profileOwner();
    const buildId = remoteAgentBuildId(owner.runtime);
    let registry: RemoteAgentRegistry = {
      ...emptyRemoteAgentRegistry(),
      builds: [
        {
          id: buildId,
          runtime: owner.runtime,
          health: "staged",
          promotion: 0,
          binary: "present",
          authenticated: true,
        },
      ],
    };
    fixture.update.mockImplementation(
      async (transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry) => {
        registry = transition(registry);
        return registry;
      },
    );
    const frames = new Set<(frame: RemoteAgentFrame) => unknown>();
    const failures = new Set<(error: Error) => void>();
    let successful = false;
    const deadlines: AbortController[] = [];
    if (deadline)
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        deadlines.push(controller);
        return controller.signal;
      });
    const request = vi.fn(
      async (
        frame: RemoteAgentFrame,
        _matches: unknown,
        signal?: AbortSignal,
      ): Promise<RemoteAgentFrame> => {
        if (!successful) {
          if (deadline)
            return new Promise((_, reject) => {
              signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
              queueMicrotask(() => {
                for (const controller of deadlines)
                  controller.abort(new Error("attach unavailable"));
              });
            });
          throw new Error("attach unavailable");
        }
        if (frame.type === "ptyAttachRequest")
          return {
            type: "ptyAttachResponse",
            value: {
              requestId: frame.value.requestId,
              ptyId: owner.resourceId,
              pid: 42,
              state: "running",
              nextSequence: 1,
              firstRetainedSequence: 1,
              replayGap: false,
            },
          };
        if (frame.type === "ptyOutputAck")
          return {
            type: "ptyOutputAckResponse",
            value: {
              requestId: frame.value.requestId,
              ptyId: owner.resourceId,
              accepted: true,
              errorCode: "",
              errorMessage: "",
            },
          };
        throw new Error("Unexpected launch/input/stop");
      },
    );
    const close = vi.fn();
    const connection = {
      request,
      close,
      onFrame: (listener: (frame: RemoteAgentFrame) => unknown) => {
        frames.add(listener);
        return () => frames.delete(listener);
      },
      onFailure: (listener: (error: Error) => void) => {
        failures.add(listener);
        return () => failures.delete(listener);
      },
    } as unknown as RemoteAgentConnection;
    const reserve = vi.fn();
    const update = vi.fn(async (_key: string, change: (value: typeof owner) => typeof owner) =>
      change(owner),
    );
    const rollback = vi.fn();
    const store = {
      get: async () => owner,
      reserve,
      update,
      rollbackPrepared: rollback,
    } as unknown as RemoteAgentOwnerStore;
    const getBound = vi.fn(async () => connection);
    const spawn = makeOwnedRemoteAgentPty(
      { getBound, onRuntimeRestart: () => () => {} } as unknown as RemoteAgentConnectionPool,
      () => store,
    );
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(
        spawn({ ...spawnInput(), recoverOnly: true, expectedRemoteResourceId: owner.resourceId }),
      ).rejects.toThrow("attach unavailable");
    expect(frames.size).toBe(0);
    expect(failures.size).toBe(0);
    expect(request).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();
    expect(registry.pins).toHaveLength(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    for (const listener of failures) listener(new Error("later transport failure"));
    await Promise.resolve();
    expect(getBound).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
    successful = true;
    const restored = await spawn({
      ...spawnInput(),
      recoverOnly: true,
      expectedRemoteResourceId: owner.resourceId,
    });
    expect(frames.size).toBe(1);
    expect(failures.size).toBe(1);
    const data = vi.fn();
    restored.onData(data);
    expect(data).toHaveBeenCalledWith(expect.stringContaining("Remote terminal restored"));
    data.mockClear();
    for (const listener of frames)
      listener({
        type: "ptyOutput",
        value: {
          ptyId: owner.resourceId,
          sequence: 1,
          bytes: new TextEncoder().encode("retained"),
        },
      });
    expect(data).toHaveBeenCalledExactlyOnceWith("retained");
    expect(request.mock.calls.map(([frame]) => frame.type)).toEqual([
      "ptyAttachRequest",
      "ptyAttachRequest",
      "ptyAttachRequest",
      "ptyAttachRequest",
      "ptyOutputAck",
    ]);
    expect(close).not.toHaveBeenCalled();
    expect(registry.pins).toHaveLength(1);
    restored.detach?.();
    expect(frames.size).toBe(0);
    expect(failures.size).toBe(0);
  },
);
