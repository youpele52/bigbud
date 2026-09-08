import type {
  CommandId,
  MessageId,
  OrchestrationTurnControlOperation,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { useCallback, useMemo } from "react";
import { readNativeApi } from "../../../rpc/nativeApi";
import { newCommandId, newMessageId } from "~/lib/utils";

export const MAX_QUEUED_PROMPTS = 5;

export interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: string;
}

export type QueuePromptResult = "queued" | "empty" | "full";

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

export function buildComposerFollowUpCommand(input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdAt: string;
}) {
  return {
    type: "thread.message.submit" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    message: { messageId: input.messageId, text: input.text },
    delivery: "auto" as const,
    createdAt: input.createdAt,
  };
}

export function usePromptQueue(input: UsePromptQueueInput) {
  const queuedPrompts = input.projectedPrompts;
  const controlPending =
    input.controlOperation != null &&
    !["completed", "failed", "superseded", "cancelled"].includes(input.controlOperation.state);

  const queuedPromptCount = queuedPrompts.length;
  const hasQueuedPrompts = queuedPromptCount > 0;
  const canQueueMorePrompts = queuedPromptCount < MAX_QUEUED_PROMPTS;

  const queuePrompt = useCallback(
    (text: string): QueuePromptResult => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return "empty";
      }

      if (queuedPrompts.length >= MAX_QUEUED_PROMPTS) {
        return "full";
      }
      const id = input.newId();
      const createdAt = new Date().toISOString();
      void readNativeApi()
        ?.orchestration.dispatchCommand(
          buildComposerFollowUpCommand({
            commandId: newCommandId(),
            threadId: input.threadId,
            messageId: id as MessageId,
            text: trimmed,
            createdAt,
          }),
        )
        .catch((error: unknown) => input.onError(promptQueueErrorMessage(error)));
      return "queued";
    },
    [input, queuedPrompts.length],
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

  const interruptAndFlushQueuedPrompts = useCallback(async () => {
    if (queuedPrompts.length === 0) {
      return;
    }
    try {
      if (input.activeTurnInProgress) {
        await input.onInterrupt({
          queuedPromptIdsAfterSettlement: queuedPrompts.map((prompt) => prompt.id as MessageId),
        });
        return;
      }
      await readNativeApi()?.orchestration.dispatchCommand({
        type: "thread.queued-prompt.flush",
        commandId: newCommandId(),
        threadId: input.threadId,
        messageIds: queuedPrompts.map((prompt) => prompt.id as MessageId),
        messageId: newMessageId(),
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      input.onError(promptQueueErrorMessage(error));
    }
  }, [input, queuedPrompts]);

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
          queuedPromptIds: queuedPrompts.map((prompt) => prompt.id as MessageId),
          sessionEpoch: input.sessionEpoch,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      input.onError(promptQueueErrorMessage(error));
    }
  }, [controlPending, input, queuedPrompts]);

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
    ],
  );
}
