import { afterEach, expect, it, vi } from "vitest";
import { makeOwnedRemoteAgentProcess } from "./remoteAgentOwnedProcess.ts";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import {
  configureRemoteAgentOwners,
  type RemoteAgentOwner,
  type RemoteAgentOwnerStore,
} from "./remoteAgentOwners.ts";
import { restartFixtureBinding } from "./remoteAgentOwners.restart.binding.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import * as Control from "./remoteAgentControl.ts";
import { CommandCancelledError } from "../utils/commandCancellation.ts";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "durable tool cancellation keeps the exact runtime/resource and preserves uncertainty (failure=%s)",
  async (failure) => {
    const binding = restartFixtureBinding("g1");
    let saved: RemoteAgentOwner | undefined;
    const store = {
      get: async () => saved,
      reserve: async (owner: RemoteAgentOwner) => (saved = owner),
      update: async (_key: string, transition: (owner: RemoteAgentOwner) => RemoteAgentOwner) =>
        (saved = transition(saved!)),
      getBinding: async () => binding,
      bindConnection: async () => {},
      referencedBuildIds: async () => new Set<string>(),
    } satisfies RemoteAgentOwnerStore;
    configureRemoteAgentOwners(store);
    vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
    vi.spyOn(RemoteAgentWorkspaceClient.prototype, "openWorkspace").mockResolvedValue({} as never);
    let registry: RemoteAgentRegistry = {
      ...emptyRemoteAgentRegistry(),
      builds: [
        {
          id: remoteAgentBuildId(binding.runtime),
          runtime: binding.runtime,
          health: "staged",
          promotion: 0,
          binary: "present",
          authenticated: true,
        },
      ],
    };
    vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue({
      root: "/tmp/agent",
      run: async () => "",
      registry: {
        read: async () => registry,
        update: async (transition) => (registry = transition(registry)),
      },
    });
    const run = vi
      .spyOn(RemoteAgentProcessClient.prototype, "run")
      .mockImplementation(async () => new Promise(() => {}));
    const cancel = vi
      .spyOn(RemoteAgentProcessClient.prototype, "cancelAndWait")
      .mockImplementation(async () => {
        if (failure) throw new Error("link lost");
        return {
          requestId: "c",
          operationId: saved!.resourceId,
          cancelled: true,
          terminal: true,
          detail: "cancellation-terminal",
        };
      });
    const getBound = vi.fn(async () => ({}));
    const runner = makeRemoteAgentToolRunner({
      resolve: vi.fn(),
      runOwned: makeOwnedRemoteAgentProcess({ getBound } as never),
    });
    const controller = new AbortController();
    const running = runner({
      invocationId: "original-invocation",
      executionTargetId: "ssh:original",
      cwd: "/srv/original",
      command: "sleep",
      signal: controller.signal,
    });
    const observed = running.catch((cause: unknown) => cause);
    await expect.poll(() => run.mock.calls.length).toBe(1);
    const resource = saved!.resourceId;
    expect(resource).not.toBe("original-invocation");
    controller.abort();
    expect(String(await observed)).toContain(failure ? "could not be confirmed" : "cancelled");
    expect(cancel).toHaveBeenCalledWith({ operationId: resource });
    expect(saved).toMatchObject({
      resourceId: resource,
      target: "ssh:original",
      state: failure ? "outcome-unknown" : "terminal",
    });
    expect(registry.pins).toHaveLength(failure ? 1 : 0);
    expect(getBound).toHaveBeenCalledWith(
      "ssh:original",
      { runtime: binding.runtime, expectedEpoch: binding.expectedEpoch },
      expect.any(Array),
    );
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it("a pre-dispatch abort is terminal without sending or cancelling a process", async () => {
  const controller = new AbortController();
  controller.abort();
  const { withCommandCancellation } = await import("../utils/commandCancellation.ts");
  const dispatch = vi.fn();
  const cancel = vi.fn();
  await expect(withCommandCancellation(controller.signal, dispatch, cancel)).rejects.toBeInstanceOf(
    CommandCancelledError,
  );
  expect(dispatch).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
