import { Effect } from "effect";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { runtimePromptFingerprint } from "./Runtime.admission.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import { createHash } from "node:crypto";
import { resolveV2RuntimeBinding } from "./Runtime.binding.ts";
import { V2StartAttempt } from "./Runtime.start.ts";

/** Durable job identity reuses terminal results, never retries uncertain execution or applies memory. */
export function makeV2LearningReview(runtime: OpencodeV2Runtime) {
  return Effect.fn("OpencodeV2.runBackgroundReview")(function* (
    request: Parameters<ProviderServiceShape["runBackgroundReview"]>[0],
  ) {
    const owned = learningAdmissionIdentity(request.ownerThreadId, request.jobId);
    const fail = (operation: string) =>
      new ProviderAdapterValidationError({
        provider: "opencodeV2",
        operation,
        issue:
          "V2 learning execution is failed/unconfirmed; durable admission retained. No resend or result application.",
      });
    const read = () => runtime.options.journal.find(owned.identity);
    const startInput = {
      threadId: owned.threadId,
      provider: "opencodeV2" as const,
      cwd: request.cwd,
      modelSelection: request.modelSelection,
      runtimeMode: "approval-required" as const,
      ...(request.providerRuntimeExecutionTargetId
        ? { providerRuntimeExecutionTargetId: request.providerRuntimeExecutionTargetId }
        : {}),
      ...(request.workspaceExecutionTargetId
        ? { workspaceExecutionTargetId: request.workspaceExecutionTargetId }
        : {}),
    };
    yield* runtime.options.journal
      .assertOwnerAvailable(request.ownerThreadId)
      .pipe(Effect.mapError(() => fail("runBackgroundReview")));
    const result = yield* read().pipe(Effect.mapError(() => fail("runBackgroundReview")));
    if (result?.state === "terminal") {
      const binding = yield* Effect.tryPromise({
        try: async (signal) => {
          const prepared = await runtime.options.prepareSession?.(startInput, signal, true);
          try {
            return await resolveV2RuntimeBinding(
              prepared?.options ?? runtime.options,
              prepared?.input ?? startInput,
            );
          } finally {
            await prepared?.resources.cleanup();
          }
        },
        catch: () => fail("runBackgroundReview"),
      });
      if (
        result.binding.location !== binding.directory ||
        result.binding.storageIdentity !== binding.storageIdentity ||
        result.binding.nativeSessionId !== binding.nativeSessionId ||
        result.binding.threadId !== owned.threadId ||
        result.binding.runtimeTargetId !== binding.runtimeTarget ||
        result.binding.workspaceTargetId !== binding.workspaceTarget
      )
        return yield* fail("runBackgroundReview");
      const selection = request.modelSelection;
      if (
        selection.provider !== "opencodeV2" ||
        !selection.subProviderID ||
        result.fingerprint !==
          runtimePromptFingerprint(
            request.input,
            {
              id: selection.model,
              providerID: selection.subProviderID,
              ...(selection.options?.variant ? { variant: selection.options.variant } : {}),
            },
            createHash("sha256").update("[]").digest("hex"),
            v2ExecutionPolicy(),
          )
      )
        return yield* fail("runBackgroundReview");
      if (
        result.terminalOutcome !== "completed" ||
        !result.finalText ||
        result.finalText.length > 24000
      )
        return yield* fail("runBackgroundReview");
      return result.finalText; // Existing LearningReview parser/validation remains authoritative.
    }
    const attempt = new V2StartAttempt();
    const run = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => runtime.start(startInput, attempt, true),
        catch: () => fail("runBackgroundReview"),
      });
      yield* Effect.tryPromise({
        try: () =>
          runtime.send({
            threadId: owned.threadId,
            requestMessageId: owned.identity.requestMessageId,
            learningJob: { ownerThreadId: request.ownerThreadId, jobId: request.jobId },
            input: request.input,
            modelSelection: request.modelSelection,
          }),
        catch: () => fail("runBackgroundReview"),
      });
      while (true) {
        const row = yield* read().pipe(Effect.mapError(() => fail("runBackgroundReview")));
        if (row?.state === "terminal") {
          if (row.terminalOutcome !== "completed" || !row.finalText || row.finalText.length > 24000)
            return yield* fail("runBackgroundReview");
          return row.finalText;
        }
        const session = runtime.sessions.get(owned.threadId);
        if (!session || session.stopped) return yield* fail("runBackgroundReview");
        yield* Effect.sleep("100 millis");
      }
    }).pipe(
      Effect.timeout("3 minutes"),
      Effect.mapError(() => fail("runBackgroundReview")),
    );
    return yield* run.pipe(
      Effect.onExit(() =>
        Effect.tryPromise({
          try: () => runtime.cancelStart(attempt),
          catch: () => fail("ProviderService.runBackgroundReview.cleanup"),
        }),
      ),
    );
  });
}
