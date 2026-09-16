import type {
  RemoteAgentRestartRecord,
  RemoteAgentRestartStore,
} from "./remoteAgentRestart.types.ts";
import type {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";

let configuredStore: RemoteAgentRestartStore | undefined;
export function configureRemoteAgentRestartStore(store: RemoteAgentRestartStore): void {
  configuredStore = store;
}
export function remoteAgentRestartStore(): RemoteAgentRestartStore | undefined {
  return configuredStore;
}

export function resultFor(
  record: RemoteAgentRestartRecord,
  request: ServerRestartRemoteAgentInput,
): ServerRestartRemoteAgentResult {
  return {
    requestId: request.requestId,
    projectId: request.projectId,
    executionTargetId: record.target,
    phase: record.phase,
    message: record.message,
    oldEpoch: record.oldEpoch,
    ...(record.replacementEpoch ? { replacementEpoch: record.replacementEpoch } : {}),
  };
}

/** Process-local fallback used only when persistence is not composed (tests/fixtures). */
export function makeMemoryStore(): RemoteAgentRestartStore {
  const records = new Map<string, RemoteAgentRestartRecord>();
  const canonical = async (id: string): Promise<RemoteAgentRestartRecord | undefined> => {
    const record = records.get(id);
    if (!record || !record.canonicalRequestId || record.canonicalRequestId === id) return record;
    return canonical(record.canonicalRequestId);
  };
  return {
    get: canonical,
    put: async (record) => {
      if (!records.has(record.requestId)) records.set(record.requestId, record);
    },
    update: async (id, transition) => {
      const current = records.get(id);
      if (!current) throw new Error("Remote restart request is not durable.");
      const next = { ...transition(current), revision: (current.revision ?? 0) + 1 };
      records.set(id, next);
      return next;
    },
    findActive: async (runtime, projectId) => {
      for (const record of records.values()) {
        if (
          record.projectId === projectId &&
          record.runtime.generation === runtime.generation &&
          !["ready", "failed", "unknown"].includes(record.phase)
        )
          return canonical(record.requestId);
      }
      return undefined;
    },
  };
}

export async function joinRestartOperation(
  store: RemoteAgentRestartStore,
  request: ServerRestartRemoteAgentInput,
  result: ServerRestartRemoteAgentResult,
  resolveBinding: (target: string) => Promise<RemoteAgentRuntimeBinding | undefined>,
  existing: RemoteAgentRestartRecord | undefined,
): Promise<ServerRestartRemoteAgentResult> {
  if (!existing) {
    if (!result.oldEpoch) throw new Error("Joined restart has no old runtime identity.");
    const binding = await resolveBinding(request.expectedWorkspaceExecutionTargetId);
    if (!binding) throw new Error("Runtime identity is unavailable.");
    await store.put({
      requestId: request.requestId,
      canonicalRequestId: result.requestId,
      projectId: request.projectId,
      target: result.executionTargetId,
      runtime: binding.runtime,
      oldEpoch: result.oldEpoch,
      phase: result.phase,
      ...(result.replacementEpoch ? { replacementEpoch: result.replacementEpoch } : {}),
      message: `Joined restart ${result.requestId}: ${result.message}`,
    });
  }
  return { ...result, requestId: request.requestId, projectId: request.projectId };
}

export async function findAndJoinDurableRestart(
  store: RemoteAgentRestartStore,
  request: ServerRestartRemoteAgentInput,
  resolveBinding: (target: string) => Promise<RemoteAgentRuntimeBinding | undefined>,
  knownBinding?: RemoteAgentRuntimeBinding,
): Promise<ServerRestartRemoteAgentResult | undefined> {
  const binding =
    knownBinding ?? (await resolveBinding(request.expectedWorkspaceExecutionTargetId));
  if (!binding) return undefined;
  const record = await store.findActive?.(binding.runtime, request.projectId);
  if (!record || record.requestId === request.requestId) return undefined;
  await store.put({
    ...record,
    requestId: request.requestId,
    canonicalRequestId: record.canonicalRequestId ?? record.requestId,
  });
  return {
    requestId: request.requestId,
    projectId: request.projectId,
    executionTargetId: record.target,
    phase: record.phase,
    message: record.message,
    oldEpoch: record.oldEpoch,
    ...(record.replacementEpoch ? { replacementEpoch: record.replacementEpoch } : {}),
  };
}
