import { CommandId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  THREAD_ORGANIZATION_STATES,
  THREAD_SNOOZE_MAX_MINUTES,
  THREAD_SNOOZE_MIN_MINUTES,
  type ThreadOrganization,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { Effect } from "effect";

import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { currentThreadOrganization } from "../orchestration/threadOrganization.logic.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import { resolveThreadToolParticipants } from "./ThreadOrchestrationTools.participants.ts";
import { stableThreadToolId } from "./ThreadOrchestrationTools.origins.ts";

export interface ThreadOrganizationToolResult {
  readonly threadId: ThreadId;
  readonly organization: ThreadOrganization;
  /** False when the thread was already organized that way, or the call was a replay. */
  readonly changed: boolean;
  readonly commandId: CommandId;
}

type OrganizationToolInput = {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
  /** Authenticated caller; never replaced by the requested target. */
  readonly threadId: ThreadId;
  readonly targetThreadId?: ThreadId;
  readonly invocationId?: string;
};

type OrganizationCommand =
  | { readonly type: "thread.organization.move"; readonly state: ThreadOrganizationState }
  | { readonly type: "thread.organization.snooze"; readonly durationMinutes: number };

const isState = (value: string): value is ThreadOrganizationState =>
  (THREAD_ORGANIZATION_STATES as readonly string[]).includes(value);

const organizationFromEvents = (
  events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>,
): ThreadOrganization | null => {
  const event = events.findLast((entry) => entry.type === "thread.organization-updated");
  return event ? (event.payload as { organization: ThreadOrganization }).organization : null;
};

/**
 * Shared path for agent moves and snoozes: authorizes like rename, refuses archived targets,
 * and replays a retried invocation from its committed events instead of applying it twice.
 */
const applyOrganizationCommand = Effect.fn("applyThreadOrganizationToolCommand")(function* (
  input: OrganizationToolInput,
  command: OrganizationCommand,
) {
  if (input.targetThreadId !== undefined && !input.targetThreadId.trim()) {
    return yield* Effect.fail(new Error("Target thread ID cannot be empty."));
  }
  const targetThreadId = input.targetThreadId ?? input.threadId;
  const { targetThread } = yield* resolveThreadToolParticipants({
    ...input,
    callerThreadId: input.threadId,
    threadId: targetThreadId,
    operation: "organize",
  });
  if (targetThread.archivedAt !== null) {
    return yield* Effect.fail(new Error(`Thread '${targetThreadId}' is archived.`));
  }

  const invocationId = input.invocationId?.trim();
  const commandId = CommandId.makeUnsafe(
    invocationId
      ? stableThreadToolId(
          "command",
          JSON.stringify([input.threadId, targetThreadId, invocationId, command.type]),
        )
      : `agent:${command.type}:${crypto.randomUUID()}`,
  );
  const readEvents = input.orchestrationEngine.readEventsByCommandId;
  const committed = readEvents ? organizationFromEvents(yield* readEvents(commandId)) : null;
  if (committed) {
    return { threadId: targetThreadId, organization: committed, changed: false, commandId };
  }

  const dispatched = yield* input.orchestrationEngine
    .dispatch({
      ...command,
      commandId,
      threadId: targetThreadId,
      createdAt: new Date().toISOString(),
    })
    .pipe(
      Effect.map(() => true),
      // A retried no-op commits no events, so its retry differs only in `createdAt`.
      Effect.catchTag("OrchestrationCommandIdConflictError", () => Effect.succeed(false)),
    );
  const applied =
    dispatched && readEvents ? organizationFromEvents(yield* readEvents(commandId)) : null;
  if (applied) return { threadId: targetThreadId, organization: applied, changed: true, commandId };
  const current = yield* ensureOrchestrationThreadState(
    input.orchestrationEngine,
    targetThreadId,
    "operational",
  );
  return {
    threadId: targetThreadId,
    organization: currentThreadOrganization(current ?? targetThread),
    changed: false,
    commandId,
  };
});

/** Moves a thread between Ìtútù states. Organizing never touches execution or approvals. */
export const moveThreadViaOrchestration = Effect.fn("moveThreadViaOrchestration")(function* (
  input: OrganizationToolInput & { readonly state: string },
) {
  if (!isState(input.state)) {
    return yield* Effect.fail(
      new Error(`State must be one of ${THREAD_ORGANIZATION_STATES.join(", ")}.`),
    );
  }
  return yield* applyOrganizationCommand(input, {
    type: "thread.organization.move",
    state: input.state,
  });
});

/** Snoozes a thread into Later until a server-calculated deadline. */
export const snoozeThreadViaOrchestration = Effect.fn("snoozeThreadViaOrchestration")(function* (
  input: OrganizationToolInput & { readonly minutes: number },
) {
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < THREAD_SNOOZE_MIN_MINUTES ||
    input.minutes > THREAD_SNOOZE_MAX_MINUTES
  ) {
    return yield* Effect.fail(
      new Error(
        `Snooze minutes must be a whole number from ${THREAD_SNOOZE_MIN_MINUTES} to ${THREAD_SNOOZE_MAX_MINUTES}.`,
      ),
    );
  }
  return yield* applyOrganizationCommand(input, {
    type: "thread.organization.snooze",
    durationMinutes: input.minutes,
  });
});
