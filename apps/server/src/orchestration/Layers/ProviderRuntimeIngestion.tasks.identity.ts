import {
  RuntimeTaskId,
  type OrchestrationTask,
  type OrchestrationTaskKind,
  type ThreadId,
} from "@bigbud/contracts";

export function scopedProviderSubagentId(input: {
  readonly threadId: ThreadId;
  readonly sessionEpoch?: number;
  readonly nativeId: string;
}) {
  return RuntimeTaskId.makeUnsafe(
    `${input.threadId}:${input.sessionEpoch ?? "legacy"}:${input.nativeId}`,
  );
}

export function demotePersistedTaskActivity(task: OrchestrationTask): OrchestrationTask {
  return task.kind === "providerSubagent" && task.activityFresh
    ? { ...task, activityFresh: false }
    : task;
}

export function resolveRuntimeTaskIdentity(input: {
  readonly threadId: ThreadId;
  readonly sessionEpoch?: number;
  readonly incomingTaskId: RuntimeTaskId;
  readonly incomingKind?: OrchestrationTaskKind;
  readonly incomingNativeId?: string;
  readonly provider?: string;
  readonly currentTasks: ReadonlyArray<OrchestrationTask>;
}) {
  const nativeId = input.incomingNativeId ?? input.incomingTaskId;
  const scopedId = scopedProviderSubagentId({
    threadId: input.threadId,
    ...(input.sessionEpoch !== undefined ? { sessionEpoch: input.sessionEpoch } : {}),
    nativeId,
  });
  // Native IDs may repeat after reconnect. Only this thread/session-scoped
  // identity may contribute classification or lifecycle state.
  const previousScoped = input.currentTasks.find((task) => task.id === scopedId);
  const kind = input.incomingKind ?? previousScoped?.kind ?? "task";
  // Only V2 enrolled-family events can preserve a storage/root/native identity across epochs.
  const durable =
    input.provider === "opencodeV2" && /^bbv2-owned:[a-f0-9]{64}$/.test(input.incomingTaskId);
  const id = kind === "providerSubagent" && !durable ? scopedId : input.incomingTaskId;
  return {
    id,
    kind,
    nativeId,
    previous: input.currentTasks.find((task) => task.id === id),
  };
}
