import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadId,
} from "@bigbud/contracts";
import { Cause, Effect } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { sanitizeElevatorSummary } from "../../git/Utils.ts";
import { resolveDefaultChatCwd } from "../../ws/serverSettings.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.ts";

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

function buildElevatorSummaryTranscript(messages: ReadonlyArray<OrchestrationMessage>): string {
  const visibleMessages = messages.filter(isVisibleSummaryMessage);
  const sections: string[] = [];

  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index];
    if (!message) {
      continue;
    }
    const roleLabel = message.role === "assistant" ? "ASSISTANT" : "USER";
    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }
    const nextSection = `${roleLabel}:\n${text}`;
    sections.unshift(nextSection);
    const transcript = sections.join("\n\n");
    if (transcript.length > THREAD_ELEVATOR_SUMMARY_TRANSCRIPT_MAX_CHARS) {
      sections.shift();
      break;
    }
  }

  return sections.join("\n\n");
}

export const maybeGenerateThreadElevatorSummary = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateThreadElevatorSummary")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const thread = yield* services.resolveThread(input.threadId);
    if (!thread || !shouldRefreshThreadElevatorSummary({ thread })) {
      return;
    }

    const transcript = buildElevatorSummaryTranscript(thread.messages);
    if (transcript.length === 0) {
      return;
    }

    const visibleMessageCount = countVisibleSummaryMessages(thread.messages);
    const serverSettings = yield* services.serverSettingsService.getSettings.pipe(
      Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
    );
    const readModel = yield* services.orchestrationEngine.getReadModel();
    const generationCwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      }) ?? resolveDefaultChatCwd(serverSettings);

    const summary = yield* services.textGeneration
      .generateThreadElevatorSummary({
        cwd: generationCwd,
        transcript,
        modelSelection: thread.modelSelection,
      })
      .pipe(
        Effect.map((generated) => sanitizeElevatorSummary(generated.summary)),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate thread elevator summary", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as("")),
        ),
      );

    if (summary.length === 0) {
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
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate thread elevator summary", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });
