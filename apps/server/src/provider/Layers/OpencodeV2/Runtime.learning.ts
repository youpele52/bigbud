import { Effect } from "effect";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { runtimePromptFingerprint } from "./Runtime.admission.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { v2StorageIdentity } from "./Runtime.sessions.ts";
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
    yield* runtime.options.journal
      .assertOwnerAvailable(request.ownerThreadId)
      .pipe(Effect.mapError(() => fail("runBackgroundReview")));
    const result = yield* read().pipe(Effect.mapError(() => fail("runBackgroundReview")));
    if (result?.state === "terminal") {
      const runtimeTarget =
        request.providerRuntimeExecutionTargetId ?? runtime.options.config.runtimeTargetId;
      const workspaceTarget = request.workspaceExecutionTargetId ?? runtimeTarget;
      const binding = yield* Effect.tryPromise({
        try: async () => ({
          root:
            runtimeTarget === "local"
              ? await realpath(runtime.options.config.profileRoot)
              : path.posix.resolve(runtime.options.config.profileRoot),
          directory:
            runtimeTarget === "local"
              ? await realpath(request.cwd)
              : path.posix.resolve(request.cwd),
        }),
        catch: () => fail("runBackgroundReview"),
      });
      if (
        runtimeTarget !== runtime.options.config.runtimeTargetId ||
        result.binding.location !== binding.directory ||
        result.binding.storageIdentity !== v2StorageIdentity(runtimeTarget, binding.root) ||
        result.binding.runtimeTargetId !== runtimeTarget ||
        result.binding.workspaceTargetId !== workspaceTarget
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
        try: () =>
          runtime.start(
            {
              threadId: owned.threadId,
              provider: "opencodeV2",
              cwd: request.cwd,
              modelSelection: request.modelSelection,
              runtimeMode: "approval-required",
              ...(request.providerRuntimeExecutionTargetId
                ? { providerRuntimeExecutionTargetId: request.providerRuntimeExecutionTargetId }
                : {}),
              ...(request.workspaceExecutionTargetId
                ? { workspaceExecutionTargetId: request.workspaceExecutionTargetId }
                : {}),
            },
            attempt,
            true,
          ),
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
