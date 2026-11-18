import type { OrchestrationThread, ProjectId } from "@bigbud/contracts";
import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";

import {
  ensureOrchestrationProjectState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import {
  requireCrossProjectConfirmation,
  type ThreadCoordinationAccess,
  type ThreadCoordinationDeps,
} from "./ThreadCoordinationConfirmation.ts";

/**
 * `message` is a write (send_thread_message) that a messaging line can also allow; `write` covers
 * every other change (create, rename, move, snooze), which a line never allows.
 */
export type ThreadCoordinationMode = "read" | "write" | "message";

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

type ThreadCoordinationAccessInput = {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
  readonly coordination?: ThreadCoordinationDeps | undefined;
  readonly callerThread: OrchestrationThread;
  /** Absent for `create_thread`, whose target is a project rather than a thread. */
  readonly targetThread?: OrchestrationThread;
  readonly targetProjectId: ProjectId;
};

/** Same-project targets and the caller's direct delegated children never need confirmation. */
export const isThreadCoordinationExempt = Effect.fn("isThreadCoordinationExempt")(function* (
  input: Omit<ThreadCoordinationAccessInput, "orchestrationEngine" | "coordination">,
): Effect.fn.Return<boolean, Error> {
  if (input.callerThread.projectId === input.targetProjectId) return true;
  if (input.targetThread === undefined) return false;
  const delegation = yield* input.threadDelegationRepository
    .findDirectByChild({ childThreadId: input.targetThread.id })
    .pipe(Effect.mapError(asError));
  return Option.isSome(delegation) && delegation.value.callerThreadId === input.callerThread.id;
});

/**
 * The confirmation step for a non-exempt write: grant, the user's own request (decision 3a),
 * proof, or a structured refusal. A thread target must itself be attached; `create_thread` needs
 * an attached thread in the target project.
 */
export const requireThreadCoordinationConfirmation = Effect.fn(
  "requireThreadCoordinationConfirmation",
)(function* (
  input: Omit<ThreadCoordinationAccessInput, "threadDelegationRepository">,
): Effect.fn.Return<ThreadCoordinationAccess, Error> {
  const project = yield* ensureOrchestrationProjectState(
    input.orchestrationEngine,
    input.targetProjectId,
  );
  const readModel = yield* input.orchestrationEngine.getReadModel();
  if (!project || project.deletedAt !== null) {
    return yield* Effect.fail(new Error(`Project '${input.targetProjectId}' was not found.`));
  }
  const targetThread = input.targetThread;
  const referencesTarget = targetThread
    ? (threadId: string) => threadId === targetThread.id
    : (threadId: string) =>
        readModel.threads.some(
          (thread) =>
            thread.id === threadId &&
            thread.projectId === input.targetProjectId &&
            thread.deletedAt == null,
        );
  return yield* requireCrossProjectConfirmation({
    coordination: input.coordination,
    callerThreadId: input.callerThread.id,
    callerProvider:
      input.callerThread.session?.providerName ?? input.callerThread.modelSelection?.provider,
    referencesTarget,
    project: {
      id: project.id,
      title: project.title,
      targetIsRemote: isRemoteExecutionTargetId(
        project.workspaceExecutionTargetId ?? project.executionTargetId,
      ),
    },
  });
});

/**
 * A messaging line between the caller and the target: a line opened by an approved message
 * between them in either direction (until restart), or the target being the thread that
 * delegated the caller, so a child created in another project can always report back.
 */
export const hasThreadMessagingLine = Effect.fn("hasThreadMessagingLine")(function* (
  input: Pick<
    ThreadCoordinationAccessInput,
    "threadDelegationRepository" | "coordination" | "callerThread" | "targetThread"
  >,
): Effect.fn.Return<boolean, Error> {
  const target = input.targetThread;
  if (target === undefined) return false;
  const grants = input.coordination?.grants;
  if (grants && (yield* grants.hasLine(input.callerThread.id, target.id))) return true;
  const delegation = yield* input.threadDelegationRepository
    .findDirectByChild({ childThreadId: input.callerThread.id })
    .pipe(Effect.mapError(asError));
  return Option.isSome(delegation) && delegation.value.callerThreadId === target.id;
});

/**
 * Reads are open across projects. Writes are allowed for same-project targets and direct
 * delegated children as before; a message is also allowed over a messaging line. Anything else
 * needs a server-verified user confirmation, returned as a structured refusal rather than a
 * failure. An allowed cross-project message opens a line, so the target can reply without
 * asking (a two-way line between the two threads, never their whole projects).
 */
export const requireThreadCoordinationAccess = Effect.fn("requireThreadCoordinationAccess")(
  function* (
    input: ThreadCoordinationAccessInput & { readonly mode: ThreadCoordinationMode },
  ): Effect.fn.Return<ThreadCoordinationAccess, Error> {
    if (input.mode === "read") return { kind: "allowed" };
    if (yield* isThreadCoordinationExempt(input)) return { kind: "allowed" };
    if (input.mode === "message" && (yield* hasThreadMessagingLine(input))) {
      return { kind: "allowed" };
    }
    const access = yield* requireThreadCoordinationConfirmation(input);
    const grants = input.coordination?.grants;
    if (access.kind === "allowed" && input.mode === "message" && input.targetThread && grants) {
      yield* grants.openLine(input.callerThread.id, input.targetThread.id);
    }
    return access;
  },
);
