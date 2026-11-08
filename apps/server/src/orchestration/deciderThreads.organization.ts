/**
 * Decider cases for Inyosira organization commands.
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

import { effectiveOrganizationActivity, organizationWithAge } from "./threadOrganization.aging.ts";
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
import { isThreadQuiescent, organizationAfterIdle } from "./threadOrganization.idle.logic.ts";

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

export type ThreadOrganizationCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.organization.move"
      | "thread.organization.react"
      | "thread.organization.snooze"
      | "thread.organization.snooze.expire"
      | "thread.organization.idle";
  }
>;

export const THREAD_ORGANIZATION_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "thread.organization.move",
  "thread.organization.react",
  "thread.organization.snooze",
  "thread.organization.snooze.expire",
  "thread.organization.idle",
]);

function organizationUpdatedEvent(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: ThreadId;
  readonly organization: ThreadOrganization;
  readonly reason: ThreadOrganizationChangeReason;
  readonly occurredAt: string;
  readonly current: ThreadOrganization;
  readonly automatic?: boolean;
}): DecidedEvent {
  const source =
    input.automatic || input.reason === "idle" || input.reason === "snooze-expired"
      ? ("automatic" as const)
      : ("deliberate" as const);
  const payload = {
    threadId: input.threadId,
    organization: input.organization,
    reason: input.reason,
    source,
  };
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.organization-updated",
    payload: { ...payload, organization: organizationWithAge(input.current, payload) },
  };
}

export const decideThreadOrganizationCommand = Effect.fn("decideThreadOrganizationCommand")(
  function* (input: {
    readonly command: ThreadOrganizationCommand;
    readonly readModel: OrchestrationReadModel;
  }): Effect.fn.Return<ReadonlyArray<DecidedEvent>, OrchestrationCommandInvariantError> {
    const { command, readModel } = input;
    if (
      command.type === "thread.organization.snooze.expire" ||
      command.type === "thread.organization.idle"
    ) {
      // Automation that lost its race is a no-op, never an error, so sweeps cannot retry forever.
      const thread = readModel.threads.find((entry) => entry.id === command.threadId);
      if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) return [];
      if (thread.deletingAt) return [];
      const occurredAt = nowIso();
      const current = currentThreadOrganization(thread);
      if (command.type === "thread.organization.idle" && command.terminalIdleCutoff !== undefined) {
        const activity = effectiveOrganizationActivity({
          createdAt: thread.createdAt,
          // Operational read models expose updatedAt, which conservatively overcounts activity.
          // The serialized SQL guard separately rechecks the exact projection age/gates.
          lastActivityAt: thread.updatedAt,
          organization: current,
          completedAt: thread.latestTurn?.completedAt ?? null,
        });
        if (activity === null || activity > command.terminalIdleCutoff) return [];
      }
      // Commands are decided one at a time, so admitted work always blocks a later idle move.
      const organization =
        command.type === "thread.organization.idle"
          ? isThreadQuiescent(thread)
            ? organizationAfterIdle(current, { ...command, occurredAt })
            : null
          : organizationAfterSnoozeExpiry(current, { snoozeId: command.snoozeId, occurredAt });
      if (organization === null) return [];
      const { commandId, threadId } = command;
      return [
        organizationUpdatedEvent({
          commandId,
          threadId,
          organization,
          occurredAt,
          reason: command.type === "thread.organization.idle" ? "idle" : "snooze-expired",
          current,
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
          current,
        }),
      ];
    }

    if (
      command.type === "thread.organization.move" &&
      command.expectedRevision !== undefined &&
      command.expectedRevision !== current.revision
    ) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Thread '${command.threadId}' was reorganized since revision ${command.expectedRevision}.`,
      });
    }
    const organization =
      command.type === "thread.organization.move" &&
      current.state === command.state &&
      current.snooze === null
        ? { ...current, revision: current.revision + 1, changedAt: occurredAt }
        : organizationAfterMove(current, command.state, occurredAt);
    if (organization === null) return [];
    const { commandId, threadId } = command;
    return [
      organizationUpdatedEvent({
        commandId,
        threadId,
        organization,
        occurredAt,
        reason: "move",
        current,
        automatic: command.type === "thread.organization.react",
      }),
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
      current,
    }),
  ];
}
