import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { Deferred, Effect, Option, Schema } from "effect";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { supportsProviderWorkload } from "../providerWorkloadSupport.ts";
import {
  prepareProviderSession,
  type SessionPreparationDependencies,
} from "./ProviderService.prepareSession.ts";
import { toValidationError } from "./ProviderServiceHelpers.ts";
import { makeBackgroundReviewResponse } from "./ProviderService.backgroundReview.response.ts";
import {
  learningAdmissionIdentity,
  isDurableLearningThread,
} from "./OpencodeV2/Admission.identity.ts";

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
  const isBackground = (threadId: ThreadId) =>
    threadId.startsWith(prefix) || isDurableLearningThread(threadId);
  const process = (event: ProviderRuntimeEvent) =>
    handlers.get(event.threadId)?.(event) ?? Effect.void;
  const run: ProviderServiceShape["runBackgroundReview"] = Effect.fn("runBackgroundReview")(
    function* (request) {
      const durableReview =
        request.modelSelection.provider === "opencodeV2"
          ? learningAdmissionIdentity(request.ownerThreadId, request.jobId)
          : undefined;
      const threadId =
        durableReview?.threadId ?? ThreadId.makeUnsafe(`${prefix}${crypto.randomUUID()}`);
      const fail = (detail: string) =>
        toValidationError("ProviderService.runBackgroundReview", detail);
      if (durableReview) {
        const adapter = yield* input.registry.getByProvider("opencodeV2");
        if (adapter.runBackgroundReview) {
          return yield* adapter
            .runBackgroundReview(request)
            .pipe(
              Effect.mapError((error) =>
                toValidationError(
                  Schema.is(ProviderAdapterValidationError)(error) &&
                    error.operation === "ProviderService.runBackgroundReview.cleanup"
                    ? "ProviderService.runBackgroundReview.cleanup"
                    : "ProviderService.runBackgroundReview",
                  Schema.is(ProviderAdapterValidationError)(error) &&
                    error.operation === "ProviderService.runBackgroundReview.cleanup"
                    ? "V2 review cleanup remains unconfirmed; retain owner lease and do not retry."
                    : "Isolated V2 durable review failed or remains unconfirmed.",
                  error,
                ),
              ),
            );
        }
      }
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
          const response = makeBackgroundReviewResponse(RESPONSE_LIMIT);
          handlers.set(threadId, (event) => {
            if (!response.append(event)) {
              return Deferred.fail(
                completed,
                fail("Background review response exceeded 24000 characters."),
              ).pipe(Effect.asVoid);
            }
            if (event.type === "turn.completed") {
              return (
                event.payload.state === "completed"
                  ? Deferred.succeed(completed, response.text())
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
                ...(durableReview
                  ? {
                      requestMessageId: durableReview.identity.requestMessageId,
                      learningJob: { ownerThreadId: request.ownerThreadId, jobId: request.jobId },
                    }
                  : {}),
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
