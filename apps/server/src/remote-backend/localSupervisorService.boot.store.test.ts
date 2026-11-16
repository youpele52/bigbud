import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import { describe, expect, it, vi } from "vitest";
import { restartRemoteAgentRuntime } from "../remote-agent/remoteAgentRestart.runtime.ts";
import { remoteAgentRestartAttemptId } from "../remote-agent/remoteAgentRestart.identity.ts";
import { makeLocalSupervisorBootProgressStore } from "./localSupervisorService.boot.store.ts";
import { bootFixture } from "./localSupervisorService.boot.test.helpers.ts";

describe("project-free canonical account boot restart", () => {
  it("replaces a proven prior-boot runtime through the same P4 reservation and returns durable completion on retry", async () => {
    const f = bootFixture();
    let binding: RemoteAgentRuntimeBinding = { runtime: f.selected, expectedEpoch: "42" };
    const launchReplacement = vi.fn(async () => {
      expect(f.state().launches[0]).toMatchObject({
        attemptId: remoteAgentRestartAttemptId(f.requestId),
        phase: "spawn-uncertain",
      });
      expect(f.state().admissions).toEqual([]);
      return "launch-reserved";
    });
    const dependencies = {
      store: f.store,
      stopLiveSupervisor: false,
      close: vi.fn(),
      reconnect: vi.fn(async () => undefined),
      resolveBinding: async () => binding,
      verifySsh: async () => undefined,
      control: async () => f.owner,
      verifyReadiness: vi.fn(async () => "43"),
      launchReplacement,
      bindReplacement: async (
        _target: string,
        _connectionId: string,
        replacement: typeof binding,
      ) => {
        binding = replacement;
      },
    };
    const request = { requestId: f.requestId, expectedWorkspaceExecutionTargetId: f.target };
    const result = await restartRemoteAgentRuntime(dependencies, request);
    expect(result).toMatchObject({ phase: "ready", oldEpoch: "42", replacementEpoch: "43" });
    expect(result).not.toHaveProperty("projectId");
    expect(f.state().restartReservations).toHaveLength(1);
    expect(await restartRemoteAgentRuntime(dependencies, request)).toMatchObject({
      phase: "ready",
      replacementEpoch: "43",
    });
    expect(launchReplacement).toHaveBeenCalledOnce();
    expect(dependencies.verifyReadiness).toHaveBeenCalledOnce();
  });

  it("refuses to stop a live supervisor after a boot proxy failure, preserving prior admission and pins", async () => {
    const f = bootFixture("live");
    const launchReplacement = vi.fn(async () => "launch-reserved");
    const reconnect = vi.fn(async () => undefined);
    await expect(
      restartRemoteAgentRuntime(
        {
          store: f.store,
          stopLiveSupervisor: false,
          close: vi.fn(),
          reconnect,
          resolveBinding: async () => ({ runtime: f.selected, expectedEpoch: "42" }),
          verifySsh: async () => undefined,
          control: async () => f.owner,
          launchReplacement,
        },
        { requestId: f.requestId, expectedWorkspaceExecutionTargetId: f.target },
      ),
    ).rejects.toThrow("live supervisor was not stopped");
    expect(launchReplacement).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([command]) => command.includes("--restart-supervisor"))).toBe(
      false,
    );
    expect(f.state().admissions[0]).toMatchObject({ id: "original", phase: "ready", epoch: "42" });
    expect(f.state().pins[0]?.owner).toBe("connection:original");
    expect((await f.store.get(f.requestId))?.phase).toBe("unknown");
  });

  it.each(["other-restart", "retirement", "deleting"] as const)(
    "atomically refuses %s ownership before adding a boot reservation",
    async (conflict) => {
      const f = bootFixture();
      const buildId = f.state().builds[0]!.id;
      await f.owner.registry.update((state) => ({
        ...state,
        revision: state.revision + 1,
        ...(conflict === "deleting"
          ? { builds: state.builds.map((build) => ({ ...build, binary: "deleting" as const })) }
          : {}),
        ...(conflict === "retirement"
          ? {
              retirementReservations: [
                {
                  id: "retiring",
                  buildId,
                  generation: f.selected.generation,
                  phase: "reserved" as const,
                },
              ],
            }
          : {}),
        ...(conflict === "other-restart"
          ? {
              restartReservations: [
                {
                  id: "other",
                  buildId,
                  generation: f.selected.generation,
                  expectedEpoch: "42",
                  phase: "starting" as const,
                },
              ],
            }
          : {}),
      }));
      await expect(
        f.store.put({
          requestId: f.requestId,
          target: f.target,
          runtime: f.selected,
          oldEpoch: "42",
          phase: "prepared",
          message: "Reserved",
        }),
      ).rejects.toThrow("canonical runtime operation");
      expect(f.state().restartReservations.some((row) => row.id === f.requestId)).toBe(false);
    },
  );

  it("refuses another runtime identity instead of treating a canonical reservation as a new project row", async () => {
    const f = bootFixture();
    await f.store.put({
      requestId: f.requestId,
      target: f.target,
      runtime: f.selected,
      oldEpoch: "42",
      phase: "prepared",
      message: "Reserved",
    });
    const other = makeLocalSupervisorBootProgressStore({
      control: f.control,
      runtime: f.selected,
      oldEpoch: "99",
      requestId: f.requestId,
    });
    await expect(other.get(f.requestId)).rejects.toThrow("identity changed");
    await expect(f.store.get("different-request")).rejects.toThrow("another runtime attempt");
  });
});
