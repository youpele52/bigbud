/**
 * Task-event branch of runtime ingestion: task upserts, removals and the provider-subagent
 * throttle flushes. Runs inside the thread's sequential worker, so flushes preserve order.
 *
 * @module ProviderRuntimeIngestion.processor.tasks
 */
import {
  CommandId,
  type OrchestrationTask,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@bigbud/contracts";
import { Clock, Effect } from "effect";

import type { RuntimeProcessorServices } from "./ProviderRuntimeIngestion.processor.ts";
import { SubagentUpsertThrottle } from "./ProviderRuntimeIngestion.subagentThrottle.ts";
import {
  buildRuntimeTaskSnapshot,
  isDuplicateClaudeLifecycleUpsert,
  isTerminalTaskStatus,
  type TaskUpsertRuntimeEvent,
} from "./ProviderRuntimeIngestion.tasks.map.ts";
import { resolveRuntimeTaskIdentity } from "./ProviderRuntimeIngestion.tasks.identity.ts";

/** Runtime events after which every pending subagent snapshot of the thread is persisted. */
const SUBAGENT_FLUSH_BOUNDARY_EVENTS: ReadonlySet<ProviderRuntimeEvent["type"]> = new Set([
  "turn.completed",
  "turn.aborted",
  "session.state.changed",
  "session.exited",
]);

const isTaskUpsertEvent = (event: ProviderRuntimeEvent): event is TaskUpsertRuntimeEvent =>
  event.type === "task.started" ||
  event.type === "task.progress" ||
  event.type === "task.completed" ||
  event.type === "task.updated";

export function makeRuntimeTaskProcessor(input: {
  readonly orchestrationEngine: RuntimeProcessorServices["orchestrationEngine"];
  readonly providerCommandId: (event: ProviderRuntimeEvent, tag: string) => CommandId;
  readonly subagentThrottle?: SubagentUpsertThrottle;
}) {
  const { orchestrationEngine } = input;
  const throttle = input.subagentThrottle ?? new SubagentUpsertThrottle();
  let nextTaskOrdinal = 0;

  const readTasks = (threadId: string) =>
    orchestrationEngine
      .getReadModel()
      .pipe(
        Effect.map(
          (readModel) => readModel.threads.find((thread) => thread.id === threadId)?.tasks ?? [],
        ),
      );

  /** Persists deferred snapshots unless a newer or terminal state superseded them. */
  const persistPending = Effect.fn("persistPendingSubagentUpserts")(function* (
    threadId: string,
    pending: ReadonlyArray<OrchestrationTask>,
    commandId: () => CommandId,
  ) {
    if (pending.length === 0) return;
    const current = yield* readTasks(threadId);
    for (const task of pending) {
      const existing = current.find((entry) => entry.id === task.id);
      if (!existing || existing.updatedAt > task.updatedAt) continue;
      if (isTerminalTaskStatus(existing.status) && !isTerminalTaskStatus(task.status)) continue;
      yield* orchestrationEngine.dispatch({
        type: "thread.task.upsert",
        commandId: commandId(),
        threadId: threadId as ThreadId,
        task,
        createdAt: task.updatedAt,
      });
    }
  });

  const upsertTask = Effect.fn("upsertTask")(function* (deps: {
    readonly event: TaskUpsertRuntimeEvent;
    readonly threadId: ThreadId;
  }) {
    const identity = resolveRuntimeTaskIdentity({
      threadId: deps.threadId,
      provider: deps.event.provider,
      ...(deps.event.sessionEpoch !== undefined ? { sessionEpoch: deps.event.sessionEpoch } : {}),
      incomingTaskId: deps.event.payload.taskId,
      ...(deps.event.type === "task.updated" && deps.event.payload.kind !== undefined
        ? { incomingKind: deps.event.payload.kind }
        : {}),
      ...(deps.event.type === "task.updated" && deps.event.payload.nativeId !== undefined
        ? { incomingNativeId: deps.event.payload.nativeId }
        : {}),
      currentTasks: yield* readTasks(deps.threadId),
    });
    const base = throttle.pending(deps.threadId, identity.id) ?? identity.previous;
    if (isDuplicateClaudeLifecycleUpsert(deps.event, base)) return;
    const task = buildRuntimeTaskSnapshot({
      event: deps.event,
      taskId: identity.id,
      taskKind: identity.kind,
      nativeId: identity.nativeId,
      previous: base,
      ordinal: nextTaskOrdinal++,
    });
    const decision = throttle.decide({
      threadId: deps.threadId,
      task,
      previous: base,
      nowMs: yield* Clock.currentTimeMillis,
    });
    for (const evicted of decision.evicted) {
      yield* persistPending(evicted.threadId, [evicted.task], () =>
        input.providerCommandId(deps.event, "thread-task-upsert-evicted"),
      );
    }
    if (!decision.persist) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.task.upsert",
      commandId: input.providerCommandId(deps.event, "thread-task-upsert"),
      threadId: deps.threadId,
      task,
      createdAt: deps.event.createdAt,
    });
  });

  /** Opportunistic flush: runs before every runtime event of the thread. */
  const flushDue = Effect.fn("flushDueSubagentUpserts")(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
  ) {
    const due = throttle.takeDue(threadId, yield* Clock.currentTimeMillis);
    yield* persistPending(threadId, due, () =>
      input.providerCommandId(event, "thread-task-upsert-flush"),
    );
  });

  /** Handles the task branch, then the bounded flush at turn and session boundaries. */
  const processTaskEvent = Effect.fn("processRuntimeTaskEvent")(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
  ) {
    if (event.type === "task.removed") {
      throttle.discard(threadId, event.payload.taskId);
      yield* orchestrationEngine.dispatch({
        type: "thread.task.remove",
        commandId: input.providerCommandId(event, "thread-task-remove"),
        threadId,
        taskId: event.payload.taskId,
        source: event.payload.source,
        freshness: event.payload.freshness,
        ...(event.payload.replacement ? { replacement: event.payload.replacement } : {}),
        createdAt: event.createdAt,
      });
    } else if (isTaskUpsertEvent(event)) {
      yield* upsertTask({ event, threadId });
    }
    if (SUBAGENT_FLUSH_BOUNDARY_EVENTS.has(event.type)) {
      yield* persistPending(threadId, throttle.takeAll(threadId), () =>
        input.providerCommandId(event, "thread-task-upsert-boundary"),
      );
    }
  });

  /** Ingestion shutdown: persists every pending snapshot across threads. */
  const flushAll = Effect.suspend(() =>
    Effect.forEach(
      throttle.takeEverything(),
      (entry) =>
        persistPending(entry.threadId, [entry.task], () =>
          CommandId.makeUnsafe(`provider:subagent-shutdown-flush:${crypto.randomUUID()}`),
        ),
      { discard: true },
    ),
  );

  return { flushDue, processTaskEvent, flushAll };
}
