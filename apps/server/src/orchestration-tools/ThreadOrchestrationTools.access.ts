import type { OrchestrationThread, ProjectId } from "@bigbud/contracts";
import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import {
  requireCrossProjectConfirmation,
  type ThreadCoordinationAccess,
  type ThreadCoordinationDeps,
} from "./ThreadCoordinationConfirmation.ts";

export type ThreadCoordinationMode = "read" | "write";

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
  const readModel = yield* input.orchestrationEngine.getReadModel();
  const project = readModel.projects.find((candidate) => candidate.id === input.targetProjectId);
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
 * Reads are open across projects. Writes are allowed for same-project targets and direct
 * delegated children as before; any other project needs a server-verified user confirmation,
 * returned as a structured refusal rather than a failure.
 */
export const requireThreadCoordinationAccess = Effect.fn("requireThreadCoordinationAccess")(
  function* (
    input: ThreadCoordinationAccessInput & { readonly mode: ThreadCoordinationMode },
  ): Effect.fn.Return<ThreadCoordinationAccess, Error> {
    if (input.mode === "read") return { kind: "allowed" };
    if (yield* isThreadCoordinationExempt(input)) return { kind: "allowed" };
    return yield* requireThreadCoordinationConfirmation(input);
  },
);
