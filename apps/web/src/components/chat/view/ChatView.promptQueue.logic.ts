import type {
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationTurnControlOperation,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import type { UploadChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";
import { useCallback, useMemo } from "react";
import { readNativeApi } from "../../../rpc/nativeApi";
import { newCommandId, newMessageId } from "~/lib/utils";

export const MAX_QUEUED_PROMPTS = 5;

export interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: string;
  /** Already in the transcript; the server redelivers it, so the panel does not list it. */
  alreadySent?: boolean | undefined;
}

export type QueuePromptResult = "queued" | "empty" | "full";

/** Everything a composer send carries; execution settings only when they differ from the thread. */
export interface QueuedPromptSubmission {
  readonly text: string;
  readonly attachments?: ReadonlyArray<UploadChatAttachment>;
  readonly replyToMessageId?: MessageId;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

/** Prompts the user queued; already-sent redeliveries are shown by their timeline bubble. */
export function visibleQueuedPrompts<T extends QueuedPrompt>(prompts: readonly T[]): T[] {
  return prompts.filter((prompt) => prompt.alreadySent !== true);
}

export function formatQueuedPromptText(prompts: readonly QueuedPrompt[]) {
  const numberedPrompts = prompts
    .map((prompt, index) => `${index + 1}. ${prompt.text.trim()}`)
    .join("\n\n");

  return ["Additional instructions:", "", numberedPrompts].join("\n");
}

interface UsePromptQueueInput {
  threadId: ThreadId;
  projectedPrompts: readonly QueuedPrompt[];
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null | undefined;
  sessionEpoch?: number | undefined;
  controlOperation?: OrchestrationTurnControlOperation | null | undefined;
  nativeSteer?: boolean;
  canSteer?: boolean;
  onInterrupt: (options?: {
    queuedPromptIdsAfterSettlement?: readonly MessageId[];
  }) => Promise<void>;
  onError: (message: string) => void;
  newId: () => string;
  /**
   * Persists the composer's model and modes on the thread, as a composer send does. "Send now"
   * runs on the thread's settings, so the user's picker choice must reach the server first.
   */
  persistSettingsBeforeRelease?: (() => Promise<void>) | undefined;
}

export function promptQueueErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to update the prompt queue.";
}

export function buildSendNowInterruptCommand(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly commandId: CommandId;
  readonly queuedPromptIds: readonly MessageId[];
  readonly createdAt: string;
  readonly sessionEpoch?: number | undefined;
}) {
  return {
    type: "thread.turn.interrupt" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    queuedPromptIdsAfterSettlement: input.queuedPromptIds,
    ...(input.sessionEpoch !== undefined ? { sessionEpoch: input.sessionEpoch } : {}),
    createdAt: input.createdAt,
  };
}

export function buildSteerCommand(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly commandId: CommandId;
  readonly queuedPromptIds: readonly MessageId[];
  readonly createdAt: string;
  readonly sessionEpoch?: number | undefined;
}) {
  return {
    type: "thread.turn.steer" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    turnId: input.turnId,
    queuedPromptIds: input.queuedPromptIds,
    ...(input.sessionEpoch !== undefined ? { sessionEpoch: input.sessionEpoch } : {}),
    createdAt: input.createdAt,
  };
}

/**
 * "Send now" on an idle thread. It is the user's own send, so it also releases a held queue (a
 * fork's held message, or a queue held after Stop); automatic flushes never carry `userRelease`.
 */
export function buildSendNowFlushCommand(input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageIds: ReadonlyArray<MessageId>;
  readonly messageId: MessageId;
  readonly createdAt: string;
}) {
  return {
    type: "thread.queued-prompt.flush" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    messageIds: [...input.messageIds],
    messageId: input.messageId,
    userRelease: true,
    createdAt: input.createdAt,
  };
}

/**
 * "Send now": interrupt the running turn (the server flushes the queue on settlement), or persist
 * the composer's settings and then release the idle queue. Settings are never persisted mid-turn:
 * a runtime-mode change restarts the provider session and would race the interrupt. If the
 * settings cannot be saved, nothing is sent and the error is reported.
 */
export async function sendNowQueuedPrompts(input: {
  readonly queuedPromptIds: ReadonlyArray<MessageId>;
  readonly activeTurnInProgress: boolean;
  readonly persistSettingsBeforeRelease?: (() => Promise<void>) | undefined;
  readonly interrupt: (queuedPromptIds: ReadonlyArray<MessageId>) => Promise<void>;
  readonly flush: (queuedPromptIds: ReadonlyArray<MessageId>) => Promise<unknown>;
  readonly onError: (message: string) => void;
}): Promise<void> {
  if (input.queuedPromptIds.length === 0) return;
  try {
    if (input.activeTurnInProgress) {
      await input.interrupt(input.queuedPromptIds);
      return;
    }
    await input.persistSettingsBeforeRelease?.();
    await input.flush(input.queuedPromptIds);
  } catch (error) {
    input.onError(promptQueueErrorMessage(error));
  }
}

export function buildComposerFollowUpCommand(input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly submission: QueuedPromptSubmission;
  readonly createdAt: string;
}) {
  const { submission } = input;
  return {
    type: "thread.message.submit" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      text: submission.text.trim(),
      ...(submission.attachments?.length ? { attachments: [...submission.attachments] } : {}),
      ...(submission.replyToMessageId !== undefined
        ? { replyToMessageId: submission.replyToMessageId }
        : {}),
    },
    ...(submission.modelSelection !== undefined
      ? { modelSelection: submission.modelSelection }
      : {}),
    ...(submission.runtimeMode !== undefined ? { runtimeMode: submission.runtimeMode } : {}),
    ...(submission.interactionMode !== undefined
      ? { interactionMode: submission.interactionMode }
      : {}),
    delivery: "auto" as const,
    createdAt: input.createdAt,
  };
}

function isEmptySubmission(submission: QueuedPromptSubmission) {
  return submission.text.trim().length === 0 && (submission.attachments?.length ?? 0) === 0;
}

export function usePromptQueue(input: UsePromptQueueInput) {
  // Control commands cover the whole server queue; the panel and limit use the visible part.
  const allQueuedPrompts = input.projectedPrompts;
  const queuedPrompts = useMemo(() => visibleQueuedPrompts(allQueuedPrompts), [allQueuedPrompts]);
  const controlPending =
    input.controlOperation != null &&
    !["completed", "failed", "superseded", "cancelled"].includes(input.controlOperation.state);

  const queuedPromptCount = queuedPrompts.length;
  const hasQueuedPrompts = queuedPromptCount > 0;
  const canQueueMorePrompts = queuedPromptCount < MAX_QUEUED_PROMPTS;

  /** Queues a full composer submission; rejects when the server refuses it. */
  const submitQueuedPrompt = useCallback(
    async (submission: QueuedPromptSubmission): Promise<QueuePromptResult> => {
      if (isEmptySubmission(submission)) return "empty";
      if (queuedPrompts.length >= MAX_QUEUED_PROMPTS) return "full";
      const api = readNativeApi();
      if (!api) throw new Error("The app is not connected.");
      await api.orchestration.dispatchCommand(
        buildComposerFollowUpCommand({
          commandId: newCommandId(),
          threadId: input.threadId,
          messageId: input.newId() as MessageId,
          submission,
          createdAt: new Date().toISOString(),
        }),
      );
      return "queued";
    },
    [input, queuedPrompts.length],
  );

  const queuePrompt = useCallback(
    (text: string): QueuePromptResult => {
      if (isEmptySubmission({ text })) return "empty";
      if (queuedPrompts.length >= MAX_QUEUED_PROMPTS) return "full";
      void submitQueuedPrompt({ text }).catch((error: unknown) =>
        input.onError(promptQueueErrorMessage(error)),
      );
      return "queued";
    },
    [input, queuedPrompts.length, submitQueuedPrompt],
  );

  const removeQueuedPrompt = useCallback(
    (id: string) => {
      void readNativeApi()
        ?.orchestration.dispatchCommand({
          type: "thread.queued-prompt.remove",
          commandId: newCommandId(),
          threadId: input.threadId,
          messageId: id as MessageId,
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => input.onError(promptQueueErrorMessage(error)));
    },
    [input],
  );

  const interruptAndFlushQueuedPrompts = useCallback(
    () =>
      sendNowQueuedPrompts({
        queuedPromptIds: allQueuedPrompts.map((prompt) => prompt.id as MessageId),
        activeTurnInProgress: input.activeTurnInProgress,
        persistSettingsBeforeRelease: input.persistSettingsBeforeRelease,
        interrupt: (queuedPromptIds) =>
          input.onInterrupt({ queuedPromptIdsAfterSettlement: queuedPromptIds }),
        flush: async (messageIds) =>
          readNativeApi()?.orchestration.dispatchCommand(
            buildSendNowFlushCommand({
              commandId: newCommandId(),
              threadId: input.threadId,
              messageIds,
              messageId: newMessageId(),
              createdAt: new Date().toISOString(),
            }),
          ),
        onError: input.onError,
      }),
    [allQueuedPrompts, input],
  );

  const steerQueuedPrompts = useCallback(async () => {
    if (
      input.canSteer !== true ||
      !input.activeTurnInProgress ||
      input.activeTurnId === null ||
      input.activeTurnId === undefined ||
      controlPending ||
      queuedPrompts.length === 0
    ) {
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    try {
      await api.orchestration.dispatchCommand(
        buildSteerCommand({
          threadId: input.threadId,
          turnId: input.activeTurnId,
          commandId: newCommandId(),
          queuedPromptIds: allQueuedPrompts.map((prompt) => prompt.id as MessageId),
          sessionEpoch: input.sessionEpoch,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      input.onError(promptQueueErrorMessage(error));
    }
  }, [allQueuedPrompts, controlPending, input, queuedPrompts.length]);

  return useMemo(
    () => ({
      queuedPrompts,
      queuedPromptCount,
      hasQueuedPrompts,
      canQueueMorePrompts,
      canSteer: input.canSteer === true,
      nativeSteer: input.nativeSteer === true,
      controlOperation: input.controlOperation ?? null,
      queuePrompt,
      submitQueuedPrompt,
      removeQueuedPrompt,
      interruptAndFlushQueuedPrompts,
      steerQueuedPrompts,
    }),
    [
      canQueueMorePrompts,
      hasQueuedPrompts,
      input.canSteer,
      input.controlOperation,
      input.nativeSteer,
      interruptAndFlushQueuedPrompts,
      queuePrompt,
      queuedPromptCount,
      queuedPrompts,
      removeQueuedPrompt,
      steerQueuedPrompts,
      submitQueuedPrompt,
    ],
  );
}
