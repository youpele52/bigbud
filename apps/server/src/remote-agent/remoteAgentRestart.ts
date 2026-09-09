import type {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";

import { verifySshExecutionTarget } from "../ssh/sshVerification.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { buildRemoteAgentSupervisorRestartCommand } from "./remoteAgentSupervisor.ts";
import {
  buildManagedRemoteAgentReplacementLaunch,
  buildRemoteAgentReplacementDeathEvidence,
  buildRemoteAgentReplacementReadiness,
} from "./remoteAgentRuntime.launch.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import {
  findAndJoinDurableRestart,
  joinRestartOperation,
  makeMemoryStore,
  remoteAgentRestartStore,
  resultFor,
} from "./remoteAgentRestart.store.ts";
import {
  type RemoteAgentRestartRecord,
  type RemoteAgentRestartServiceShape,
  type RemoteAgentRestartStore,
} from "./remoteAgentRestart.types.ts";
export { RemoteAgentRestartService } from "./remoteAgentRestart.types.ts";
export type { RemoteAgentRestartServiceShape } from "./remoteAgentRestart.types.ts";
const MAX_REQUESTS = 64;
const terminalPhases = new Set(["ready", "failed", "unknown"]);
const runtimeKey = (binding: RemoteAgentRuntimeBinding) =>
  `${binding.runtime.generation}:${binding.expectedEpoch}`;

export function makeRemoteAgentRestart(input: {
  readonly close: (target: string, binding?: RemoteAgentRuntimeBinding) => void;
  readonly reconnect: (
    target: string,
    replacement?: RemoteAgentRuntimeBinding,
    retired?: RemoteAgentRuntimeBinding,
  ) => Promise<void>;
  readonly resolveBinding?: typeof remoteAgentAdmission.resolveBinding;
  readonly verifySsh?: (target: string) => Promise<void>;
  readonly verifyReadiness?: (
    target: string,
    runtime: RemoteAgentRuntime,
    expectedEpoch?: string,
  ) => Promise<string>;
  readonly control?: (target: string) => ReturnType<typeof openRemoteAgentControl>;
  readonly store?: RemoteAgentRestartStore;
  readonly beginRetirement?: (target: string, generation: string) => Promise<() => void>;
  readonly reconcileRuntime?: (target: string, binding: RemoteAgentRuntimeBinding) => Promise<void>;
}): RemoteAgentRestartServiceShape {
  const active = new Map<string, Promise<ServerRestartRemoteAgentResult>>();
  const retirementReleases = new Map<string, () => void>();
  const fallbackStore = makeMemoryStore();
  const storeFor = () => input.store ?? remoteAgentRestartStore() ?? fallbackStore;
  const resolveBinding = input.resolveBinding ?? remoteAgentAdmission.resolveBinding;
  const verifySsh =
    input.verifySsh ??
    (async (target: string) => {
      await verifySshExecutionTarget({ executionTargetId: target });
    });
  const status = async (request: ServerRestartRemoteAgentInput) => {
    let record = await storeFor().get(request.requestId);
    const statusBinding = await resolveBinding(request.expectedWorkspaceExecutionTargetId);
    if (record && !terminalPhases.has(record.phase) && statusBinding)
      record = (await storeFor().findActive?.(statusBinding.runtime, record.projectId)) ?? record;
    if (
      !record ||
      record.projectId !== request.projectId ||
      (record.target !== request.expectedWorkspaceExecutionTargetId &&
        statusBinding?.runtime.generation !== record.runtime.generation)
    )
      throw new Error("Remote restart request was not found for this project and target.");
    return resultFor(record, request);
  };
  return {
    status,
    restart: async (request) => {
      await verifySsh(request.expectedWorkspaceExecutionTargetId);
      const binding = await resolveBinding(request.expectedWorkspaceExecutionTargetId);
      const activeKey = binding
        ? `${request.projectId}:${runtimeKey(binding)}`
        : `${request.projectId}:target:${request.expectedWorkspaceExecutionTargetId}`;
      const existing = active.get(activeKey);
      if (existing) {
        return storeFor()
          .get(request.requestId)
          .then((record) => {
            if (record && record.projectId !== request.projectId)
              throw new Error(
                "Remote restart request identity conflicts with an existing request.",
              );
            return existing.then((result) =>
              joinRestartOperation(storeFor(), request, result, resolveBinding, record),
            );
          });
      }
      const durableResult = await findAndJoinDurableRestart(
        storeFor(),
        request,
        resolveBinding,
        binding,
      );
      if (durableResult) return durableResult;
      if (active.size >= MAX_REQUESTS)
        return Promise.reject(new Error("Remote restart capacity is temporarily exhausted."));
      const operationBase = restartRemoteAgent(
        {
          close: input.close,
          reconnect: input.reconnect,
          resolveBinding,
          verifySsh,
          ...(input.verifyReadiness ? { verifyReadiness: input.verifyReadiness } : {}),
          ...(input.control ? { control: input.control } : {}),
          store: storeFor(),
          ...(input.beginRetirement
            ? {
                beginRetirement: async (target: string, generation: string) => {
                  const release = await input.beginRetirement!(target, generation);
                  retirementReleases.set(request.requestId, release);
                  return release;
                },
              }
            : {}),
          ...(input.reconcileRuntime ? { reconcileRuntime: input.reconcileRuntime } : {}),
        },
        request,
        binding,
      );
      const operation = operationBase.catch(async (cause) => {
        retirementReleases.get(request.requestId)?.();
        retirementReleases.delete(request.requestId);
        const current = await storeFor().get(request.requestId);
        if (current && !terminalPhases.has(current.phase)) {
          const phase = ["stopping", "stopped", "starting"].includes(current.phase)
            ? "unknown"
            : "failed";
          await storeFor().update(request.requestId, (record) => ({
            ...record,
            phase,
            message:
              phase === "unknown"
                ? "The remote service restart outcome is uncertain; it was not retried."
                : cause instanceof Error
                  ? cause.message
                  : "Remote service restart failed before stopping.",
          }));
        }
        throw cause;
      });
      active.set(activeKey, operation);
      void operation.then(
        () => {
          active.delete(activeKey);
          retirementReleases.delete(request.requestId);
        },
        () => {
          active.delete(activeKey);
          retirementReleases.delete(request.requestId);
        },
      );
      return operation;
    },
  };
}

async function restartRemoteAgent(
  dependencies: {
    readonly close: (target: string, binding?: RemoteAgentRuntimeBinding) => void;
    readonly reconnect: (
      target: string,
      replacement?: RemoteAgentRuntimeBinding,
      retired?: RemoteAgentRuntimeBinding,
    ) => Promise<void>;
    readonly resolveBinding: typeof remoteAgentAdmission.resolveBinding;
    readonly verifySsh: (target: string) => Promise<void>;
    readonly verifyReadiness?: (
      target: string,
      runtime: RemoteAgentRuntime,
      expectedEpoch?: string,
    ) => Promise<string>;
    readonly control?: (target: string) => Promise<{
      readonly run: (command: string) => Promise<string>;
      readonly registry: {
        readonly update: (
          transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry,
        ) => Promise<RemoteAgentRegistry>;
      };
    }>;
    readonly store: RemoteAgentRestartStore;
    readonly beginRetirement?: (target: string, generation: string) => Promise<() => void>;
    readonly reconcileRuntime?: (target: string, binding: RemoteAgentRuntimeBinding) => void;
  },
  request: ServerRestartRemoteAgentInput,
  initialBinding?: RemoteAgentRuntimeBinding,
): Promise<ServerRestartRemoteAgentResult> {
  const target = request.expectedWorkspaceExecutionTargetId;
  const prior = await dependencies.store.get(request.requestId);
  if (prior && terminalPhases.has(prior.phase)) return resultFor(prior, request);
  await dependencies.verifySsh(target);
  const binding = initialBinding ?? (await dependencies.resolveBinding(target));
  if (!binding) throw new Error("The selected remote service is not available.");
  if (binding.runtime.origin !== "managed")
    throw new Error("This remote agent does not advertise verified restart support.");
  const runtime = validateRemoteAgentRuntime(binding.runtime);
  const oldEpoch = binding.expectedEpoch;
  const releaseRetirement = dependencies.beginRetirement
    ? await dependencies.beginRetirement(target, runtime.generation)
    : undefined;
  if (
    prior &&
    !(prior.phase === "stopping" || prior.phase === "starting") &&
    (prior.oldEpoch !== oldEpoch || JSON.stringify(prior.runtime) !== JSON.stringify(runtime))
  )
    return resultFor(
      {
        ...prior,
        phase: "unknown",
        message: "The restart request no longer matches the selected runtime.",
      },
      request,
    );
  if (!prior)
    await dependencies.store.put({
      requestId: request.requestId,
      projectId: request.projectId,
      target,
      runtime,
      oldEpoch,
      phase: "prepared",
      message: "Remote service restart prepared.",
    });
  const control = await (dependencies.control?.(target) ?? openRemoteAgentControl(target));
  await control.registry.update((state) => {
    const priorReservation = state.restartReservations.find(
      (entry) => entry.id === request.requestId,
    );
    const active = state.restartReservations.find(
      (entry) =>
        entry.generation === runtime.generation && !["failed", "ready"].includes(entry.phase),
    );
    if (active && active.id !== request.requestId)
      throw new Error("Remote runtime restart is already reserved.");
    if (priorReservation) {
      if (
        priorReservation.expectedEpoch !== oldEpoch ||
        priorReservation.buildId !== `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`
      )
        throw new Error("Remote restart reservation identity changed.");
      return state;
    }
    return {
      ...state,
      revision: state.revision + 1,
      restartReservations: [
        ...state.restartReservations,
        {
          id: request.requestId,
          buildId: `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`,
          generation: runtime.generation,
          expectedEpoch: oldEpoch,
          phase: "reserved" as const,
        },
      ],
    };
  });
  const setReservationPhase = async (phase: "ready" | "failed") => {
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      restartReservations: state.restartReservations.map((entry) =>
        entry.id === request.requestId ? { ...entry, phase } : entry,
      ),
    }));
  };
  const completeRestart = async (): Promise<ServerRestartRemoteAgentResult> => {
    if (prior?.phase === "stopping" || prior?.phase === "starting") {
      const replacement = await dependencies.resolveBinding(target);
      if (replacement && replacement.expectedEpoch !== oldEpoch) {
        const record = await dependencies.store.update(request.requestId, (current) => ({
          ...current,
          phase: "ready",
          message: "The remote service was restarted and verified.",
          replacementEpoch: replacement.expectedEpoch,
        }));
        await setReservationPhase("ready");
        releaseRetirement?.();
        return resultFor(record, request);
      }
      const record = await dependencies.store.update(request.requestId, (current) => ({
        ...current,
        phase: "unknown",
        message:
          "The restart response was lost while stopping; the service was not restarted again.",
      }));
      await setReservationPhase("failed");
      releaseRetirement?.();
      return resultFor(record, request);
    }
    if (!prior || prior.phase === "prepared") {
      await dependencies.store.update(request.requestId, (record) => ({
        ...record,
        phase: "stopping",
        message: "Stopping the remote service.",
      }));
      await control.registry.update((state) => ({
        ...state,
        revision: state.revision + 1,
        restartReservations: state.restartReservations.map((entry) =>
          entry.id === request.requestId ? { ...entry, phase: "stopping" as const } : entry,
        ),
      }));
      await control.run(
        buildRemoteAgentSupervisorRestartCommand({
          binaryPath: runtime.binaryPath,
          statePath: runtime.statePath,
        }),
      );
      if ((await control.run(buildRemoteAgentReplacementDeathEvidence(runtime))).trim() !== "dead")
        throw new Error("The old supervisor did not provide verified death evidence.");
      await dependencies.store.update(request.requestId, (record) => ({
        ...record,
        phase: "stopped",
        message: "Remote service stopped; reconnecting.",
      }));
      dependencies.close(target, binding);
    }
    await dependencies.store.update(request.requestId, (record) => ({
      ...record,
      phase: "starting",
      message: "Starting the replacement remote service.",
    }));
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      restartReservations: state.restartReservations.map((entry) =>
        entry.id === request.requestId ? { ...entry, phase: "starting" as const } : entry,
      ),
    }));
    const launchResult = (
      await control.run(
        buildManagedRemoteAgentReplacementLaunch(runtime, request.requestId, oldEpoch),
      )
    ).trim();
    if (launchResult !== "launch-reserved")
      throw new Error("Replacement launch reservation was not acquired.");
    const readiness = (await control.run(buildRemoteAgentReplacementReadiness(runtime))).trim();
    if (readiness !== "ready")
      throw new Error(`Replacement readiness was not verified (${readiness}).`);
    if (dependencies.verifyReadiness) {
      const verifiedEpoch = await dependencies.verifyReadiness(target, runtime);
      if (!verifiedEpoch) throw new Error("Replacement handshake did not return an epoch.");
      const replacementBinding = await dependencies.resolveBinding(target);
      if (!replacementBinding || replacementBinding.expectedEpoch !== verifiedEpoch)
        throw new Error("Replacement readiness epoch does not match its binding.");
      await dependencies.reconnect(target, replacementBinding, binding);
    } else {
      await dependencies.reconnect(target);
    }
    const replacement = await dependencies.resolveBinding(target);
    const replacementEpoch = replacement?.expectedEpoch;
    if (!replacementEpoch || replacementEpoch === oldEpoch) {
      const record = await dependencies.store.update(request.requestId, (current) => ({
        ...current,
        phase: "unknown",
        message: "The remote service restart outcome could not be verified.",
      }));
      await setReservationPhase("failed");
      releaseRetirement?.();
      return resultFor(record, request);
    }
    await dependencies.reconcileRuntime?.(target, binding);
    const record = await dependencies.store.update(request.requestId, (current) => ({
      ...current,
      phase: "ready",
      message: "The remote service was restarted and verified.",
      replacementEpoch,
    }));
    releaseRetirement?.();
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      restartReservations: state.restartReservations.map((entry) =>
        entry.id === request.requestId ? { ...entry, phase: "ready" as const } : entry,
      ),
    }));
    return resultFor(record, request);
  };
  try {
    return await completeRestart();
  } catch (cause) {
    await setReservationPhase("failed").catch(() => undefined);
    releaseRetirement?.();
    throw cause;
  }
}
