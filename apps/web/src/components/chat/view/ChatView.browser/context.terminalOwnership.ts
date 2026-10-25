import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationRpcSchemas,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
} from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { ThreadMetaUpdatedPayload } from "@bigbud/contracts/orchestration/orchestration.events.thread.ts";
import { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { NormalizedWsRpcRequestBody } from "../../../../../test/wsRpcHarness";
import { addThreadToSnapshot, createThreadCreatedEvent } from "./fixtures";

/** Model canonical owners and accepted commands on the fake server, independently of client state. */
export function createTerminalOwnershipRpcFixture(input: {
  readSnapshot: () => OrchestrationReadModel;
  writeSnapshot: (snapshot: OrchestrationReadModel) => void;
  emitEvent: (event: OrchestrationEvent) => void;
}) {
  const outcomes = new Map<string, { threadId: ThreadId; sequence: number }>();
  const decodeCommand = Schema.decodeUnknownSync(OrchestrationRpcSchemas.dispatchCommand.input);

  function resolve(body: NormalizedWsRpcRequestBody): unknown {
    let snapshot = input.readSnapshot();
    if (body._tag === ORCHESTRATION_WS_METHODS.getThreadOwnership) {
      const thread = snapshot.threads.find((entry) => entry.id === body.threadId);
      const base = {
        threadId: body.threadId,
        serverEpoch: "browser-test",
        canonicalRevision: snapshot.snapshotSequence,
      };
      return thread
        ? { ...base, status: "active", projectId: thread.projectId }
        : { ...base, status: "absent", reusePolicy: "canonical-identity-unclaimed" };
    }
    if (body._tag === ORCHESTRATION_WS_METHODS.getCommandOutcome) {
      const outcome = outcomes.get(String(body.commandId));
      const base = {
        commandId: body.commandId,
        serverEpoch: "browser-test",
        canonicalRevision: snapshot.snapshotSequence,
      };
      return outcome
        ? {
            ...base,
            status: "accepted",
            aggregateKind: "thread",
            aggregateId: outcome.threadId,
            resultSequence: outcome.sequence,
            acceptedAt: snapshot.updatedAt,
          }
        : { ...base, status: "unknown" };
    }
    if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
    const command = decodeCommand(body);
    if (!("threadId" in command)) return undefined;
    const previous = outcomes.get(command.commandId);
    if (previous) return { sequence: previous.sequence };
    if (command.type === "thread.create") {
      if (snapshot.threads.some((thread) => thread.id === command.threadId))
        return Effect.fail(
          new OrchestrationDispatchCommandError({
            message: "Thread already exists.",
            code: "thread_already_exists",
          }),
        );
      const created = addThreadToSnapshot(snapshot, command.threadId);
      const event = createThreadCreatedEvent(command.threadId, created.snapshotSequence);
      const payload = { ...event.payload, ...command, updatedAt: command.createdAt };
      input.writeSnapshot({
        ...created,
        threads: created.threads.map((thread) =>
          thread.id === command.threadId
            ? {
                ...thread,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
                workspaceExecutionTargetId: command.workspaceExecutionTargetId,
                providerRuntimeExecutionTargetId: command.providerRuntimeExecutionTargetId,
                executionTargetId: command.executionTargetId,
                session: null,
                messages: [],
              }
            : thread,
        ),
      });
      outcomes.set(command.commandId, {
        threadId: command.threadId,
        sequence: created.snapshotSequence,
      });
      input.emitEvent({ ...event, commandId: command.commandId, payload });
      return { sequence: created.snapshotSequence };
    }
    if (command.type === "thread.turn.start") {
      if (command.message.attachments.length > 0)
        return Effect.fail(
          new OrchestrationDispatchCommandError({
            message: "This terminal fixture supports text-only turns, not attachment storage.",
          }),
        );
      if (command.bootstrap?.createThread) {
        if (snapshot.threads.some((thread) => thread.id === command.threadId))
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: "Atomic bootstrap cannot recreate an existing owner.",
              code: "thread_already_exists",
            }),
          );
        resolve({
          ...command.bootstrap.createThread,
          _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
          type: "thread.create",
          commandId: command.commandId,
          threadId: command.threadId,
          createdAt: command.createdAt,
        });
        snapshot = input.readSnapshot();
      }
      const thread = snapshot.threads.find((entry) => entry.id === command.threadId);
      if (!thread)
        return Effect.fail(
          new OrchestrationDispatchCommandError({
            message: "The turn must have a canonical thread owner.",
          }),
        );
      const sequence = snapshot.snapshotSequence + 1;
      const message = {
        id: command.message.messageId,
        role: command.message.role,
        text: command.message.text,
        createdAt: command.createdAt,
        turnId: null,
        streaming: false,
        updatedAt: command.createdAt,
      };
      input.writeSnapshot({
        ...snapshot,
        snapshotSequence: sequence,
        threads: snapshot.threads.map((entry) =>
          entry.id === command.threadId
            ? { ...entry, messages: [...entry.messages, message] }
            : entry,
        ),
      });
      outcomes.set(command.commandId, { threadId: command.threadId, sequence });
      input.emitEvent({
        sequence,
        eventId: EventId.makeUnsafe(`message-${sequence}`),
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: { ...message, threadId: command.threadId, messageId: message.id },
      });
      return { sequence };
    }
    // Metadata commands are recorded as accepted only after updating the fake projection.
    if (command.type === "thread.meta.update") {
      const sequence = snapshot.snapshotSequence + 1;
      const payload = Schema.decodeUnknownSync(ThreadMetaUpdatedPayload)({
        ...command,
        updatedAt: snapshot.updatedAt,
      });
      const { threadId, ...patch } = payload;
      input.writeSnapshot({
        ...snapshot,
        snapshotSequence: sequence,
        threads: snapshot.threads.map((thread) =>
          thread.id === threadId
            ? Schema.decodeUnknownSync(OrchestrationThread)({ ...thread, ...patch })
            : thread,
        ),
      });
      outcomes.set(command.commandId, { threadId: command.threadId, sequence });
      input.emitEvent({
        sequence,
        eventId: EventId.makeUnsafe(`thread-metadata-${sequence}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: snapshot.updatedAt,
        commandId: command.commandId,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.meta-updated",
        payload,
      });
      return { sequence };
    }
    return undefined;
  }
  return { resolve, reset: () => outcomes.clear() };
}
