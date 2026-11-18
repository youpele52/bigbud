import type { RemoteAgentReplacementLauncher } from "./remoteAgentRestart.dependencies.ts";
import type {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";

import { verifySshExecutionTarget } from "../ssh/sshVerification.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import {
  findAndJoinDurableRestart,
  joinRestartOperation,
  makeMemoryStore,
  remoteAgentRestartStore,
  resultFor,
} from "./remoteAgentRestart.store.ts";
import {
  type RemoteAgentRestartServiceShape,
  type RemoteAgentRestartStore,
} from "./remoteAgentRestart.types.ts";
export { RemoteAgentRestartService } from "./remoteAgentRestart.types.ts";
export type { RemoteAgentRestartServiceShape } from "./remoteAgentRestart.types.ts";
const MAX_REQUESTS = 64;
import { restartRemoteAgent } from "./remoteAgentRestart.operation.ts";
import { terminalPhases, RemoteAgentRestartCompletionError } from "./remoteAgentRestart.runtime.ts";
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
  readonly bindReplacement?: (
    target: string,
    connectionId: string,
    binding: RemoteAgentRuntimeBinding,
  ) => Promise<void>;
  readonly verifyReadiness?: (
    target: string,
    runtime: RemoteAgentRuntime,
    expectedEpoch?: string,
  ) => Promise<string>;
  readonly control?: (target: string) => ReturnType<typeof openRemoteAgentControl>;
  readonly launchReplacement?: RemoteAgentReplacementLauncher;
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
    const store = storeFor();
    let record = await store.get(request.requestId);
    if (!record || record.projectId !== request.projectId) {
      throw new Error("Remote restart request was not found for this project and target.");
    }

    let statusBinding: RemoteAgentRuntimeBinding | undefined;
    if (!terminalPhases.has(record.phase)) {
      try {
        statusBinding = await resolveBinding(request.expectedWorkspaceExecutionTargetId);
      } catch {
        statusBinding = undefined;
      }
      if (statusBinding)
        record = (await store.findActive?.(statusBinding.runtime, record.projectId)) ?? record;
    }

    if (
      record.target !== request.expectedWorkspaceExecutionTargetId &&
      statusBinding?.runtime.generation !== record.runtime.generation
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
          ...(input.bindReplacement ? { bindReplacement: input.bindReplacement } : {}),
          ...(input.verifyReadiness ? { verifyReadiness: input.verifyReadiness } : {}),
          ...(input.control ? { control: input.control } : {}),
          ...(input.launchReplacement ? { launchReplacement: input.launchReplacement } : {}),
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
        if (cause instanceof RemoteAgentRestartCompletionError) throw cause;
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
