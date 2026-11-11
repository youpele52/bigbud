import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { resolveDefaultChatCwd, ServerSettingsService } from "../../ws/serverSettings.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { loadMetadataContext } from "./ThreadMetadataGeneration.modelBinding.ts";
import {
  makeMetadataResultCommand,
  type MetadataCommitIdentity,
} from "./ThreadMetadataGeneration.identity.ts";
import { metadataJobIsTerminal } from "./ThreadMetadataGeneration.policy.ts";
import { makeMetadataConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { metadataContextIsCurrent } from "./ThreadMetadataGeneration.current.ts";

/** All hooks run inside the canonical event/projection/receipt transaction. Never call a provider. */
export const makeMetadataCommitHooks = Effect.fn("makeMetadataCommitHooks")(function* () {
  const repository = yield* makeThreadMetadataGenerationRepository();
  const settings = yield* ServerSettingsService;
  const configuration = yield* makeMetadataConfiguration(settings);
  const authorize = Effect.fn("metadataCommit.authorize")(function* (
    command: OrchestrationCommand,
    identity: MetadataCommitIdentity | undefined,
    model: OrchestrationReadModel,
  ) {
    if (!identity) return null;
    const invalid = () =>
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Metadata commit does not match its retained result and ownership fence.",
      });
    const found = yield* repository.get(identity.jobId);
    if (Option.isNone(found)) return yield* invalid();
    const job = found.value;
    const attempt = (yield* repository.listAttempts(job.jobId)).find(
      (a) => a.attemptId === identity.attemptId,
    );
    if (
      job.revision !== identity.jobRevision ||
      metadataJobIsTerminal(job.state) ||
      !attempt ||
      attempt.revision !== identity.attemptRevision ||
      attempt.owner !== identity.owner ||
      attempt.payloadJson !== identity.payloadJson
    )
      return yield* invalid();
    const context = yield* loadMetadataContext(repository, job).pipe(
      Effect.catchTag("MetadataCoordinatorError", () => Effect.fail(invalid())),
    );
    if (attempt.stage === "native") return yield* invalid();
    const expected = yield* makeMetadataResultCommand(job, attempt, context).pipe(
      Effect.mapError(invalid),
    );
    if (
      calculateCommandPayloadDigest(command).digest !==
      calculateCommandPayloadDigest(expected).digest
    )
      return yield* invalid();
    const state = yield* repository.readMetadataState(job.threadId);
    const apply =
      (yield* configuration.isCurrent(context.configEpoch)) &&
      metadataContextIsCurrent(
        context,
        model,
        state,
        resolveDefaultChatCwd(yield* settings.getSettings),
      );
    return {
      apply,
      settle: Effect.gen(function* () {
        const at = new Date().toISOString();
        if (
          !(yield* repository.settleAttempt({ attempt, state: apply ? "completed" : "stale", at }))
        )
          return yield* invalid();
        if (
          !(yield* repository.transitionJob({
            jobId: job.jobId,
            expectedRevision: job.revision,
            state: apply ? "completed" : "stale",
            nextAttemptAt: at,
          }))
        )
          return yield* invalid();
      }),
    };
  });
  const record = Effect.fn("metadataCommit.record")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.meta-updated") {
      if (event.payload.title !== undefined)
        yield* repository.advanceMetadataRevision(event.payload.threadId, "title");
      if (
        event.payload.elevatorSummary !== undefined ||
        event.payload.elevatorSummaryMessageCount !== undefined
      )
        yield* repository.advanceMetadataRevision(event.payload.threadId, "summary");
    }
    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "text-generation.model-succeeded" &&
      Schema.is(ModelSelection)(event.payload.activity.payload)
    ) {
      yield* repository.recordSuccessfulModel(
        event.payload.threadId,
        JSON.stringify(event.payload.activity.payload),
      );
    }
  });
  return { authorize, record };
});
