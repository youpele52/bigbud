import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { Deferred, Effect, Option } from "effect";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { supportsProviderWorkload } from "../providerWorkloadSupport.ts";
import {
  prepareProviderSession,
  type SessionPreparationDependencies,
} from "./ProviderService.prepareSession.ts";
import { toValidationError } from "./ProviderServiceHelpers.ts";

const REVIEW_TIMEOUT = "3 minutes";
const RESPONSE_LIMIT = 24_000;

/** A process-local namespace rejects late events without retaining completed IDs. */
export function makeBackgroundReviews(
  input: SessionPreparationDependencies & {
    readonly registry: ProviderAdapterRegistryShape;
  },
) {
  const prefix = `learning-${crypto.randomUUID()}-`;
  const handlers = new Map<ThreadId, (event: ProviderRuntimeEvent) => Effect.Effect<void>>();
  const isBackground = (threadId: ThreadId) => threadId.startsWith(prefix);
  const process = (event: ProviderRuntimeEvent) =>
    handlers.get(event.threadId)?.(event) ?? Effect.void;
  const run: ProviderServiceShape["runBackgroundReview"] = Effect.fn("runBackgroundReview")(
    function* (request) {
      const threadId = ThreadId.makeUnsafe(`${prefix}${crypto.randomUUID()}`);
      const fail = (detail: string) =>
        toValidationError("ProviderService.runBackgroundReview", detail);
      if (!supportsProviderWorkload(request.modelSelection.provider, "learning")) {
        return yield* fail(
          `Provider '${request.modelSelection.provider}' does not support learning.`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "learning.owner_thread_id": request.ownerThreadId,
        "learning.job_id": request.jobId,
      });
      let cleanup: Effect.Effect<void, ProviderServiceError> = Effect.void;
      const attempt = Effect.scoped(
        Effect.gen(function* () {
          const startInput = yield* prepareProviderSession(input, threadId, {
            threadId,
            provider: request.modelSelection.provider,
            modelSelection: request.modelSelection,
            cwd: request.cwd,
            ...(request.providerRuntimeExecutionTargetId
              ? { providerRuntimeExecutionTargetId: request.providerRuntimeExecutionTargetId }
              : {}),
            ...(request.workspaceExecutionTargetId
              ? { workspaceExecutionTargetId: request.workspaceExecutionTargetId }
              : {}),
            approvalPolicy: "untrusted",
            sandboxMode: "read-only",
            runtimeMode: "approval-required",
          });
          const adapter = yield* input.registry.getByProvider(startInput.provider);
          const completed = yield* Deferred.make<string, ProviderServiceError>();
          let text = "";
          handlers.set(threadId, (event) => {
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              if (text.length + event.payload.delta.length > RESPONSE_LIMIT) {
                return Deferred.fail(
                  completed,
                  fail("Background review response exceeded 24000 characters."),
                ).pipe(Effect.asVoid);
              }
              text += event.payload.delta;
            }
            if (event.type === "turn.completed") {
              return (
                event.payload.state === "completed"
                  ? Deferred.succeed(completed, text)
                  : Deferred.fail(completed, fail("Background review turn failed."))
              ).pipe(Effect.asVoid);
            }
            if (
              event.type === "turn.aborted" ||
              event.type === "request.opened" ||
              event.type === "user-input.requested" ||
              event.type === "runtime.error" ||
              event.type === "session.exited"
            ) {
              return Deferred.fail(
                completed,
                fail(`Background review cannot continue after ${event.type}.`),
              ).pipe(Effect.asVoid);
            }
            return Effect.void;
          });
          cleanup = adapter.stopSession(threadId).pipe(
            Effect.interruptible,
            Effect.timeoutOption("10 seconds"),
            Effect.flatMap((stopped) =>
              Option.isSome(stopped)
                ? Effect.void
                : Effect.fail(
                    toValidationError(
                      "ProviderService.runBackgroundReview.cleanup",
                      "Background review cleanup timed out.",
                    ),
                  ),
            ),
            Effect.catchCause((cause) =>
              Effect.fail(
                toValidationError(
                  "ProviderService.runBackgroundReview.cleanup",
                  "Background review session cleanup failed; owner activity must remain retained.",
                  cause,
                ),
              ),
            ),
            Effect.ensuring(Effect.sync(() => handlers.delete(threadId))),
          );
          return yield* Effect.raceFirst(
            Effect.gen(function* () {
              const session = yield* adapter.startSession(startInput);
              if (session.provider !== adapter.provider || session.threadId !== threadId) {
                return yield* fail("Background review adapter returned a mismatched session.");
              }
              yield* adapter.sendTurn({
                threadId,
                input: request.input,
                modelSelection: request.modelSelection,
              });
              return yield* Deferred.await(completed);
            }),
            Deferred.await(completed),
          );
        }),
      );
      const result = yield* attempt.pipe(
        Effect.timeoutOption(REVIEW_TIMEOUT),
        Effect.onExit(() => cleanup),
      );
      return Option.isSome(result)
        ? result.value
        : yield* fail("Background review timed out after 3 minutes.");
    },
  );
  const forDiscovery = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ): ProviderAdapterShape<ProviderAdapterError> => ({
    ...adapter,
    listSessions: () =>
      adapter
        .listSessions()
        .pipe(
          Effect.map((sessions) => sessions.filter((session) => !isBackground(session.threadId))),
        ),
  });
  return { run, process, isBackground, forDiscovery };
}
