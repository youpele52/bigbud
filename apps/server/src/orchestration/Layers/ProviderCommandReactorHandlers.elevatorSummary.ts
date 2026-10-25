import {
  DEFAULT_SERVER_SETTINGS,
  TextGenerationError,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadId,
} from "@bigbud/contracts";
import { Cause, Effect } from "effect";
import { hasTextGenerationUncertainty } from "@bigbud/shared/internalTextGeneration";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { sanitizeElevatorSummary } from "../../git/Utils.ts";
import { resolveDefaultChatCwd } from "../../ws/serverSettings.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { lastSuccessfulThreadModel } from "../../git/Layers/InternalTextGeneration.success.ts";
import { sameTextGenerationWorkspace } from "../../git/Layers/InternalTextGeneration.requests.ts";
import {
  recordThreadTextGenerationStatus,
  recordThreadTextGenerationStatusRequired,
  withThreadTextGenerationJob,
} from "../../git/Layers/InternalTextGeneration.status.ts";
import { uncertainTextGenerationError } from "../../git/Layers/InternalTextGeneration.uncertainty.ts";
import { makeTextGenerationDispatchClaim } from "../../git/Layers/InternalTextGeneration.dispatch.ts";

const THREAD_ELEVATOR_SUMMARY_INITIAL_MESSAGE_COUNT = 5;
const THREAD_ELEVATOR_SUMMARY_REFRESH_MESSAGE_INTERVAL = 10;
const THREAD_ELEVATOR_SUMMARY_TRANSCRIPT_MAX_CHARS = 8_000;

function isVisibleSummaryMessage(message: OrchestrationMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

export function countVisibleSummaryMessages(messages: ReadonlyArray<OrchestrationMessage>): number {
  return messages.filter(isVisibleSummaryMessage).length;
}

export function shouldRefreshThreadElevatorSummary(input: {
  readonly thread: Pick<
    OrchestrationThread,
    "archivedAt" | "deletingAt" | "deletedAt" | "elevatorSummaryMessageCount" | "messages"
  >;
}): boolean {
  if (
    input.thread.archivedAt !== null ||
    input.thread.deletingAt !== null ||
    input.thread.deletedAt !== null
  ) {
    return false;
  }

  const visibleMessageCount = countVisibleSummaryMessages(input.thread.messages);
  if (visibleMessageCount < THREAD_ELEVATOR_SUMMARY_INITIAL_MESSAGE_COUNT) {
    return false;
  }
  if (input.thread.elevatorSummaryMessageCount === 0) {
    return true;
  }
  return (
    visibleMessageCount >=
    input.thread.elevatorSummaryMessageCount + THREAD_ELEVATOR_SUMMARY_REFRESH_MESSAGE_INTERVAL
  );
}

/** Slice before formatting so enormous responses never create an unbounded temporary section. */
function boundedTranscriptSection(message: OrchestrationMessage, budget: number): string {
  if (!isVisibleSummaryMessage(message)) return "";
  const heading = message.role === "assistant" ? "ASSISTANT:\n" : "USER:\n";
  if (budget <= heading.length) return "";
  const start = message.text.search(/\S/u);
  if (start < 0) return "";
  let text = message.text.slice(start, start + budget - heading.length).trimEnd();
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text ? `${heading}${text}` : "";
}

/** Keep chronological, bounded context, reserving room for the most recent readable user intent. */
export function buildElevatorSummaryTranscript(
  messages: ReadonlyArray<OrchestrationMessage>,
): string {
  const budget = THREAD_ELEVATOR_SUMMARY_TRANSCRIPT_MAX_CHARS;
  let userIndex = -1;
  let reserved = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const section = boundedTranscriptSection(message, budget / 2);
    if (!section) continue;
    userIndex = index;
    reserved = section.length;
    break;
  }
  const sections: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && used < budget; index -= 1) {
    const isReservedUser = index === userIndex;
    const remaining = budget - used - (sections.length > 0 ? 2 : 0);
    const available = isReservedUser ? remaining : remaining - reserved - (reserved > 0 ? 2 : 0);
    const section = boundedTranscriptSection(messages[index]!, available);
    if (!section) continue;
    used += section.length + (sections.length > 0 ? 2 : 0);
    sections.unshift(section);
    if (isReservedUser) reserved = 0;
  }
  return sections.join("\n\n");
}

export const maybeGenerateThreadElevatorSummary = (services: SessionOpServices) => {
  const generate = Effect.fn("maybeGenerateThreadElevatorSummary")(function* (input: {
    readonly threadId: ThreadId;
    readonly force?: boolean;
  }) {
    const thread = yield* services.resolveThread(input.threadId);
    if (thread?.archivedAt || thread?.deletingAt || thread?.deletedAt) return;
    if (thread && hasTextGenerationUncertainty(thread.activities, "summary")) return;
    if (!thread || (!input.force && !shouldRefreshThreadElevatorSummary({ thread }))) {
      return;
    }
    const previousStatus = thread.activities.findLast(
      (activity) =>
        (activity.kind === "text-generation.failed" ||
          activity.kind === "text-generation.completed") &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "operation" in activity.payload &&
        activity.payload.operation === "summary",
    );
    if (!input.force && previousStatus?.kind === "text-generation.failed") return;
    if (input.force)
      yield* recordThreadTextGenerationStatus(
        services.orchestrationEngine,
        input.threadId,
        "summary",
        "started",
      );

    const transcript = buildElevatorSummaryTranscript(thread.messages);
    if (transcript.length === 0) {
      if (input.force)
        yield* recordThreadTextGenerationStatus(
          services.orchestrationEngine,
          input.threadId,
          "summary",
          "failed",
        );
      return;
    }

    const visibleMessageCount = countVisibleSummaryMessages(thread.messages);
    const serverSettings = yield* services.serverSettingsService.getSettings.pipe(
      Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
    );
    if (!serverSettings.textGenerationModelSelection && !lastSuccessfulThreadModel(thread)) {
      if (input.force)
        yield* recordThreadTextGenerationStatus(
          services.orchestrationEngine,
          input.threadId,
          "summary",
          "failed",
        );
      return;
    }
    const readModel = yield* services.orchestrationEngine.getReadModel();
    const generationCwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      }) ?? resolveDefaultChatCwd(serverSettings);

    const claim = makeTextGenerationDispatchClaim(
      services.orchestrationEngine,
      input.threadId,
      "summary",
    );

    const summary = yield* services.textGeneration
      .generateThreadElevatorSummary({
        cwd: generationCwd,
        transcript,
        modelSelection: thread.modelSelection,
        successfulModelSelection: lastSuccessfulThreadModel(thread),
        beforeV2Dispatch: claim.beforeV2Dispatch,
      })
      .pipe(
        Effect.map((generated) => sanitizeElevatorSummary(generated.summary)),
        Effect.flatMap((summary) =>
          summary.length > 0
            ? Effect.succeed(summary)
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadElevatorSummary",
                  detail: "Provider returned an empty summary.",
                  kind: "provider",
                }),
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const uncertainty = uncertainTextGenerationError(cause);
            if (Cause.hasInterruptsOnly(cause)) {
              if (claim.isClaimed())
                yield* recordThreadTextGenerationStatusRequired(
                  services.orchestrationEngine,
                  input.threadId,
                  "summary",
                  "uncertain",
                );
              return yield* Effect.interrupt;
            }
            yield* Effect.logWarning(
              "provider command reactor failed to generate thread elevator summary",
              {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              },
            );
            yield* recordThreadTextGenerationStatus(
              services.orchestrationEngine,
              input.threadId,
              "summary",
              uncertainty ? "uncertain" : "failed",
              uncertainty?.uncertaintyId ? { uncertaintyId: uncertainty.uncertaintyId } : undefined,
            );
            return "";
          }),
        ),
      );

    if (summary.length === 0) {
      return;
    }
    const latest = yield* services.resolveThread(input.threadId);
    if (!latest) return;
    if (
      latest.archivedAt ||
      latest.deletingAt ||
      latest.deletedAt ||
      !sameTextGenerationWorkspace(thread, latest)
    ) {
      if (input.force)
        yield* recordThreadTextGenerationStatus(
          services.orchestrationEngine,
          input.threadId,
          "summary",
          "unchanged",
        );
      return;
    }

    yield* services.orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-elevator-summary-update"),
        threadId: input.threadId,
        elevatorSummary: summary,
        elevatorSummaryMessageCount: visibleMessageCount,
      })
      .pipe(
        Effect.tap(() =>
          recordThreadTextGenerationStatus(
            services.orchestrationEngine,
            input.threadId,
            "summary",
            "completed",
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate thread elevator summary", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });
  return (input: Parameters<typeof generate>[0]) =>
    withThreadTextGenerationJob(
      services.orchestrationEngine,
      input.threadId,
      "summary",
      generate(input),
      input.force === true,
    );
};
