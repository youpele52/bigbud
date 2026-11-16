import type {
  RemoteAgentRestartRecord,
  RemoteAgentRestartStore,
} from "./remoteAgentRestart.types.ts";
import { makeRemoteAgentAdmission } from "./remoteAgentAdmission.ts";
import {
  RemoteAgentConnectionPool,
  type RemoteAgentRuntimeBinding,
} from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { describe, expect, it, vi } from "vitest";
import { makeRemoteAgentRestart } from "./remoteAgentRestart.ts";
import { runtime, store, restartRecord } from "./remoteAgentRestart.test.helpers.ts";
import { joinRestartOperation, makeMemoryStore } from "./remoteAgentRestart.store.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

describe("remote agent restart coordinator", () => {
  it.each(
    ["ready", "prior-boot-dead", "exited:0"].flatMap((observation) =>
      [false, true].map((serviceOwned) => ({ observation, serviceOwned })),
    ),
  )(
    "performs one replacement from $observation (service: $serviceOwned) and returns the durable result on retry",
    async ({ observation, serviceOwned }) => {
      let stopCommands = 0;
      const verifyReadiness = vi.fn(async () => "g2");
      const buildId = `0.2.207:${"a".repeat(64)}:x86_64-unknown-linux-gnu`;
      let registry = parseRemoteAgentRegistry(
        JSON.stringify({
          ...emptyRemoteAgentRegistry(),
          launches: [
            { id: "g1", buildId, attemptId: "original-attempt", phase: "ready", epoch: "g1" },
          ],
          builds: [
            {
              id: buildId,
              runtime: runtime("g1"),
              health: "healthy",
              promotion: 1,
              binary: "present",
              authenticated: true,
            },
          ],
          promotionSequence: 1,
          current: buildId,
          currentConnectionId: "old-connection",
          admissions: [{ id: "old-connection", buildId, phase: "ready", epoch: "g1" }],
          pins: [{ owner: "connection:old-connection", buildId }],
        }),
      );
      const control = {
        root: "/tmp/agent",
        run: vi.fn(async (command: string) => {
          if (command.endsWith("observe_supervisor\n")) return observation;
          if (command.includes("--restart-supervisor")) stopCommands++;
          if (command.includes("launch-reserved")) return "launch-reserved";
          if (command.includes("printf dead")) return "dead";
          if (command.includes("printf ready")) return "ready";
          return "";
        }),
        registry: {
          read: async () => registry,
          update: async (transition: (state: typeof registry) => typeof registry) => {
            registry = parseRemoteAgentRegistry(JSON.stringify(transition(registry)));
            return registry;
          },
        },
      };
      let durableBinding: RemoteAgentRuntimeBinding = {
        runtime: runtime("g1"),
        expectedEpoch: "g1",
      };
      const bindReplacement = async (
        _target: string,
        _id: string,
        binding: RemoteAgentRuntimeBinding,
      ) => {
        durableBinding = binding;
      };
      const admission = makeRemoteAgentAdmission({
        control: async () => control,
        bindings: {
          getBinding: async () => durableBinding,
          bindConnection: bindReplacement,
        },
      });
      const pool = new RemoteAgentConnectionPool({
        resolveBinding: admission.resolveBinding,
        create: async (_target, binding) =>
          ({
            close: vi.fn(),
            handshake: async () => ({
              protocolMajor: 1,
              protocolMinor: 0,
              agentVersion: "0.2.207",
              buildDigest: "digest",
              os: "linux",
              architecture: "x86_64",
              agentInstanceId: "fixture",
              agentEpoch: binding!.expectedEpoch,
              capabilities: [],
              maxFrameBytes: 1024,
              maxOperationOutputBytes: 1024,
              maxJournalBytes: 1024,
            }),
          }) as unknown as RemoteAgentConnection,
      });
      await pool.get("ssh:fixture");
      const launchReplacement = vi.fn(async (selected, attempt, epoch, previousAttempt) => {
        expect(selected).toEqual(runtime("g1"));
        expect(epoch).toBe("g1");
        expect(previousAttempt).toBe("original-attempt");
        expect(registry.restartReservations[0]?.phase).toBe("starting");
        expect(registry.launches[0]).toMatchObject({
          attemptId: attempt,
          phase: "spawn-uncertain",
        });
        expect(registry.admissions).toEqual([]);
        return "launch-reserved";
      });
      const restart = makeRemoteAgentRestart({
        ...(serviceOwned ? { launchReplacement } : {}),
        close: (target, binding) => {
          if (binding) pool.closeBound(target, binding);
        },
        bindReplacement,
        reconnect: async (target, replacement, retired) => {
          expect(registry.restartReservations[0]?.phase).toBe("starting");
          await pool.admitReplacement(target, replacement!, retired!);
        },
        verifySsh: async () => undefined,
        verifyReadiness,
        control: async () => control,
        resolveBinding: admission.resolveBinding,
        store: store(),
      });
      const request = {
        requestId: "restart-1",
        projectId: "project-1" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      };
      const first = restart.restart(request);
      const result = await first;
      expect(result.phase).toBe("ready");
      expect((await admission.resolveBinding("ssh:fixture"))?.expectedEpoch).toBe("g2");
      await expect(pool.get("ssh:fixture")).resolves.toBeDefined();
      expect(verifyReadiness).toHaveBeenCalledOnce();
      expect(launchReplacement).toHaveBeenCalledTimes(serviceOwned ? 1 : 0);
      expect(control.run.mock.calls.some(([command]) => command.includes("nohup"))).toBe(
        !serviceOwned,
      );
      expect(stopCommands).toBe(observation === "ready" ? 1 : 0);
      expect(registry.launches[0]).toMatchObject({
        attemptId: expect.stringMatching(/^restart-[a-f0-9]{48}$/),
        phase: "ready",
        epoch: "g2",
      });
      expect(control.run.mock.calls.some(([command]) => command.includes("original-attempt"))).toBe(
        true,
      );
      expect(await restart.restart(request)).toEqual(result);
      expect(stopCommands).toBe(observation === "ready" ? 1 : 0);
    },
  );

  it("refuses to stop a runtime without matching durable launch evidence", async () => {
    const registry = emptyRemoteAgentRegistry();
    const run = vi.fn(async () => "");
    const restart = makeRemoteAgentRestart({
      close: vi.fn(),
      reconnect: async () => undefined,
      verifySsh: async () => undefined,
      resolveBinding: async () => ({ runtime: runtime("g1"), expectedEpoch: "g1" }),
      control: async () => ({
        root: "/tmp/agent",
        run,
        registry: {
          read: async () => registry,
          update: async (transition) => transition(registry),
        },
      }),
      store: store(),
    });
    await expect(
      restart.restart({
        requestId: "missing-proof",
        projectId: "project-1" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      }),
    ).rejects.toThrow("matching launch identity");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not stop a service when SSH authentication preflight fails", async () => {
    const close = vi.fn();
    const control = vi.fn();
    const restart = makeRemoteAgentRestart({
      close,
      reconnect: async () => undefined,
      verifySsh: async () => {
        throw new Error("SSH password is required");
      },
      control,
      store: store(),
    });
    await expect(
      restart.restart({
        requestId: "restart-2",
        projectId: "project-2" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      }),
    ).rejects.toThrow("password is required");
    expect(control).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("binds a joined request to the canonical durable operation", async () => {
    const durable = makeMemoryStore();
    const canonical = {
      requestId: "restart-canonical",
      projectId: "project-3" as never,
      target: "ssh:fixture",
      runtime: runtime("g1"),
      oldEpoch: "g1",
      phase: "stopping" as const,
      message: "Stopping",
    } satisfies RemoteAgentRestartRecord;
    await durable.put(canonical);
    await joinRestartOperation(
      durable,
      {
        requestId: "restart-alias",
        projectId: "project-3" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      },
      {
        requestId: canonical.requestId,
        projectId: canonical.projectId,
        executionTargetId: canonical.target,
        phase: canonical.phase,
        message: canonical.message,
        oldEpoch: canonical.oldEpoch,
      },
      async () => ({ runtime: canonical.runtime, expectedEpoch: canonical.oldEpoch }),
      undefined,
    );
    await durable.update(canonical.requestId, (record) => ({ ...record, phase: "ready" }));

    expect((await durable.get("restart-alias"))?.phase).toBe("ready");
  });

  it("returns a terminal durable status without resolving the live binding", async () => {
    const durable = store();
    await durable.put(restartRecord({ phase: "ready", message: "Ready" }));
    const resolveBinding = vi.fn(async () => {
      throw new Error("remote binding unavailable");
    });
    const restart = makeRemoteAgentRestart({
      close: vi.fn(),
      reconnect: async () => undefined,
      resolveBinding,
      store: durable,
    });

    await expect(
      restart.status({
        requestId: "restart-status",
        projectId: "project-status" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      }),
    ).resolves.toMatchObject({ phase: "ready", message: "Ready" });
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("returns an active durable status when live binding resolution fails", async () => {
    const durable = store();
    await durable.put(restartRecord());
    const resolveBinding = vi.fn(async () => {
      throw new Error("remote binding unavailable");
    });
    const restart = makeRemoteAgentRestart({
      close: vi.fn(),
      reconnect: async () => undefined,
      resolveBinding,
      store: durable,
    });

    await expect(
      restart.status({
        requestId: "restart-status",
        projectId: "project-status" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      }),
    ).resolves.toMatchObject({ phase: "stopping", message: "Stopping" });
    expect(resolveBinding).toHaveBeenCalledOnce();
  });

  it("reconciles an active status with the current durable operation", async () => {
    const requested = restartRecord();
    const current = restartRecord({
      requestId: "restart-current",
      phase: "starting",
      message: "Starting",
    });
    const durable: RemoteAgentRestartStore = {
      ...store(),
      findActive: vi.fn(async () => current),
    };
    await durable.put(requested);
    const binding = { runtime: runtime("g1"), expectedEpoch: "g1" };
    const resolveBinding = vi.fn(async () => binding);
    const restart = makeRemoteAgentRestart({
      close: vi.fn(),
      reconnect: async () => undefined,
      resolveBinding,
      store: durable,
    });

    await expect(
      restart.status({
        requestId: requested.requestId,
        projectId: requested.projectId as never,
        expectedWorkspaceExecutionTargetId: requested.target as never,
      }),
    ).resolves.toMatchObject({
      requestId: requested.requestId,
      phase: "starting",
      message: "Starting",
    });
    expect(durable.findActive).toHaveBeenCalledWith(binding.runtime, requested.projectId);
  });

  it("rejects a project mismatch before attempting live binding resolution", async () => {
    const durable = store();
    await durable.put(restartRecord());
    const resolveBinding = vi.fn(async () => {
      throw new Error("should not resolve");
    });
    const restart = makeRemoteAgentRestart({
      close: vi.fn(),
      reconnect: async () => undefined,
      resolveBinding,
      store: durable,
    });

    await expect(
      restart.status({
        requestId: "restart-status",
        projectId: "other-project" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      }),
    ).rejects.toThrow("not found for this project and target");
    expect(resolveBinding).not.toHaveBeenCalled();
  });
});
