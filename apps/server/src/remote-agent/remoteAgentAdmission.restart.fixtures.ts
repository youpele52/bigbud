import { vi } from "vitest";
import { fixture } from "./remoteAgentAdmission.fixtures.ts";
import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";
import { makeRemoteAgentRestart } from "./remoteAgentRestart.ts";
import { makeMemoryStore } from "./remoteAgentRestart.store.ts";

export async function failedInstallFixture(observation = "exited:137", withFallbacks = false) {
  const f = fixture();
  const initial = await f.control.registry.update((state) => ({
    ...state,
    revision: state.revision + 1,
    pending: withFallbacks ? state.pending : null,
    predecessor: withFallbacks ? state.builds[0]!.id : null,
    launches: state.launches.map((launch) => ({ ...launch, attemptId: `launch-${launch.id}` })),
    currentConnectionId: "existing",
    admissions: [{ id: "existing", buildId: state.current!, phase: "ready", epoch: "epoch-g2" }],
    pins: [
      { owner: "connection:existing", buildId: state.current! },
      { owner: "terminal:retained", buildId: state.current! },
    ],
  }));
  const runtime = initial.builds[1]!.runtime;
  const run = vi.spyOn(f.control, "run").mockImplementation(async (command) => {
    if (command.includes("# Failed admission death observation")) return observation;
    if (command.endsWith("observe_supervisor\n")) return observation;
    if (command.includes("printf launch-reserved")) return "launch-reserved";
    if (command.includes("printf dead")) return "dead";
    if (command.includes("printf ready")) return "ready";
    throw new Error("Unexpected command");
  });
  f.connect.mockImplementation(() => {
    throw new Error("Supervisor proxy exited after crash");
  });
  const operations = makeRemoteAgentInstallOperations({
    stage: async () => ({ version: runtime.version, buildId: initial.pending ?? initial.current! }),
    activate: async (target, requestId) => {
      await f.admission.fresh(target, requestId);
      return { currentVersion: runtime.version };
    },
    retire: async () => ({ deferred: 0 }),
  });
  const install = async () => {
    operations.start({
      executionTargetId: "failed-install",
      operationId: "failed",
      replace: false,
    });
    return operations.wait("failed", 1_000);
  };
  const bindReplacement = vi.fn(async () => undefined);
  const reconnect = vi.fn(async () => undefined);
  const restart = makeRemoteAgentRestart({
    control: async () => f.control,
    store: makeMemoryStore(),
    resolveBinding: f.admission.resolveBinding,
    verifySsh: async () => undefined,
    verifyReadiness: async () => "replacement-epoch",
    bindReplacement,
    reconnect,
    close: vi.fn(),
  });
  const request = {
    requestId: "managed-restart",
    projectId: "project" as never,
    expectedWorkspaceExecutionTargetId: "failed-install" as never,
  };
  return { ...f, initial, runtime, run, install, restart, request, bindReplacement, reconnect };
}
