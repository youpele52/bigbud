import { CommandId, EventId, type ThreadId, type ModelSelection } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";

export type ThreadTextGenerationOperation = "title" | "summary" | "branch" | "promptSuggestion";

const activeJobs = new WeakMap<object, Map<string, Deferred.Deferred<void>>>();

export function isThreadTextGenerationJobActive(
  engine: object,
  threadId: ThreadId,
  operation: ThreadTextGenerationOperation,
): boolean {
  return activeJobs.get(engine)?.has(`${threadId}:${operation}`) ?? false;
}

/** Coalesce automatic generation and user retries for the same metadata field. */
export function withThreadTextGenerationJob<A, E, R>(
  engine: object,
  threadId: ThreadId,
  operation: ThreadTextGenerationOperation,
  job: Effect.Effect<A, E, R>,
  retryAfterActive = false,
): Effect.Effect<A | void, E, R> {
  return Effect.suspend(() => {
    const active = activeJobs.get(engine) ?? new Map<string, Deferred.Deferred<void>>();
    activeJobs.set(engine, active);
    const key = `${threadId}:${operation}`;
    const existing = active.get(key);
    if (existing)
      return Deferred.await(existing).pipe(
        Effect.andThen(
          retryAfterActive
            ? withThreadTextGenerationJob(engine, threadId, operation, job, true)
            : Effect.void,
        ),
      );
    const completed = Deferred.makeUnsafe<void>();
    active.set(key, completed);
    return job.pipe(
      Effect.ensuring(
        Effect.sync(() => active.delete(key)).pipe(
          Effect.andThen(Deferred.succeed(completed, undefined)),
        ),
      ),
    );
  });
}

/** Durable, non-message status: failures never alter chat sessions or generated content. */
export function recordThreadTextGenerationStatusRequired(
  engine: Pick<OrchestrationEngineShape, "dispatch">,
  threadId: ThreadId,
  operation: ThreadTextGenerationOperation,
  status: "failed" | "completed" | "unchanged" | "started" | "deferred" | "uncertain",
  context?: {
    readonly titleSeed?: string;
    readonly finalFailure?: boolean;
    readonly branch?: string;
    readonly worktreePath?: string;
    readonly workspaceExecutionTargetId?: string;
    readonly uncertaintyProtected?: boolean;
    readonly uncertaintyId?: string;
    readonly turnId?: string;
    readonly modelSelection?: ModelSelection;
  },
) {
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  return engine
    .dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`server:text-generation-status:${id}`),
      threadId,
      activity: {
        id: EventId.makeUnsafe(`text-generation-status:${id}`),
        tone: "info",
        kind: `text-generation.${status === "unchanged" ? "completed" : status}`,
        summary:
          status === "uncertain"
            ? `Thread ${operation} generation is unconfirmed. Automatic retries are paused; verify the original native work before starting another request.`
            : status === "failed"
              ? `Couldn’t generate thread ${operation}. You can retry without resending your message.`
              : status === "started"
                ? `Generating thread ${operation}…`
                : status === "deferred"
                  ? `Thread ${operation} generation waits for verified success`
                  : status === "unchanged"
                    ? `Existing thread ${operation} kept`
                    : `Thread ${operation} generated`,
        payload: { operation, ...context },
        turnId: null,
        createdAt,
      },
      createdAt,
    })
    .pipe(Effect.asVoid);
}

/** Informational status writes remain best-effort; paid-work claims use the required variant. */
export function recordThreadTextGenerationStatus(
  ...args: Parameters<typeof recordThreadTextGenerationStatusRequired>
) {
  return recordThreadTextGenerationStatusRequired(...args).pipe(Effect.ignoreCause({ log: true }));
}
