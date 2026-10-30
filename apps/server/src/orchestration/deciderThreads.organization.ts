/**
 * Decider cases for Ìtútù organization commands.
 *
 * Organization is independent of execution: these commands never start, stop, archive, or answer
 * anything. Archive and unarchive also record an organization update here, so every change to a
 * thread's organization is an accepted `thread.organization-updated` event.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadId,
} from "@bigbud/contracts";
import type {
  ThreadOrganization,
  ThreadOrganizationChangeReason,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThreadNotArchived, requireThreadNotDeleting } from "./commandInvariants.ts";
import { nowIso, withEventBase } from "./deciderHelpers.ts";
import {
  currentThreadOrganization,
  organizationAfterArchive,
  organizationAfterMove,
  organizationAfterSnooze,
  organizationAfterSnoozeExpiry,
  organizationAfterUnarchive,
} from "./threadOrganization.logic.ts";

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

export type ThreadOrganizationCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.organization.move"
      | "thread.organization.snooze"
      | "thread.organization.snooze.expire";
  }
>;

export const THREAD_ORGANIZATION_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "thread.organization.move",
  "thread.organization.snooze",
  "thread.organization.snooze.expire",
]);

function organizationUpdatedEvent(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: ThreadId;
  readonly organization: ThreadOrganization;
  readonly reason: ThreadOrganizationChangeReason;
  readonly occurredAt: string;
}): DecidedEvent {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.organization-updated",
    payload: {
      threadId: input.threadId,
      organization: input.organization,
      reason: input.reason,
    },
  };
}

export const decideThreadOrganizationCommand = Effect.fn("decideThreadOrganizationCommand")(
  function* (input: {
    readonly command: ThreadOrganizationCommand;
    readonly readModel: OrchestrationReadModel;
  }): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
    const { command, readModel } = input;
    if (command.type === "thread.organization.snooze.expire") {
      // A timer that lost its race is a no-op, never an error, so sweeps cannot retry it forever.
      const thread = readModel.threads.find((entry) => entry.id === command.threadId);
      if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) return [];
      if (thread.deletingAt) return [];
      const occurredAt = nowIso();
      const organization = organizationAfterSnoozeExpiry(currentThreadOrganization(thread), {
        snoozeId: command.snoozeId,
        occurredAt,
      });
      if (organization === null) return [];
      const { commandId, threadId } = command;
      return [
        organizationUpdatedEvent({
          commandId,
          threadId,
          organization,
          occurredAt,
          reason: "snooze-expired",
        }),
      ];
    }
    yield* requireThreadNotDeleting({ readModel, command, threadId: command.threadId });
    const thread = yield* requireThreadNotArchived({
      readModel,
      command,
      threadId: command.threadId,
    });
    const current = currentThreadOrganization(thread);
    const occurredAt = nowIso();

    if (command.type === "thread.organization.snooze") {
      const organization = organizationAfterSnooze(current, {
        snoozeId: command.commandId,
        durationMinutes: command.durationMinutes,
        occurredAt,
      });
      const { commandId, threadId } = command;
      return [
        organizationUpdatedEvent({
          commandId,
          threadId,
          organization,
          occurredAt,
          reason: "snooze",
        }),
      ];
    }

    if (command.expectedRevision !== undefined && command.expectedRevision !== current.revision) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Thread '${command.threadId}' was reorganized since revision ${command.expectedRevision}.`,
      });
    }
    const organization = organizationAfterMove(current, command.state, occurredAt);
    if (organization === null) return [];
    const { commandId, threadId } = command;
    return [
      organizationUpdatedEvent({ commandId, threadId, organization, occurredAt, reason: "move" }),
    ];
  },
);

/**
 * Appends the organization side effect of an accepted archive or unarchive. The lifecycle events
 * keep their own meaning; this only cancels snoozes on archive and returns unarchived threads to
 * Present.
 */
export function withLifecycleOrganizationEvents(input: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly events: DecidedEvent | ReadonlyArray<DecidedEvent>;
}): DecidedEvent | ReadonlyArray<DecidedEvent> {
  const events = Array.isArray(input.events)
    ? (input.events as ReadonlyArray<DecidedEvent>)
    : [input.events as DecidedEvent];
  const lifecycleEvent = events.find(
    (event) => event.type === "thread.archived" || event.type === "thread.unarchived",
  );
  if (lifecycleEvent === undefined || !("threadId" in lifecycleEvent.payload)) return input.events;
  const threadId = lifecycleEvent.payload.threadId;
  const thread = input.readModel.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) return input.events;
  const current = currentThreadOrganization(thread);
  const occurredAt = lifecycleEvent.occurredAt;
  const archived = lifecycleEvent.type === "thread.archived";
  const organization = archived
    ? organizationAfterArchive(current, occurredAt)
    : organizationAfterUnarchive(current, occurredAt);
  if (organization === null) return input.events;
  return [
    ...events,
    organizationUpdatedEvent({
      commandId: input.command.commandId,
      threadId,
      organization,
      occurredAt,
      reason: archived ? "archive" : "unarchive",
    }),
  ];
}
