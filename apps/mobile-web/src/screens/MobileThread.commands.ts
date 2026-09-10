import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "~/logic/user-input";

import {
  applyMobileUserInputCustomAnswer,
  resolveMobileUserInputAnswers,
} from "../components/threads/thread/composer/MobileComposer";
import type { MobilePendingUserInput } from "../lib/mobileModels";
import type { MobileDraftThread } from "../lib/mobileDraftThread";
import { clearMobileDraftThread } from "../lib/mobileDraftThread";
import { buildMobileCreateThreadBootstrap } from "../logic/mobileNewThread.logic";
import type { MobileRecoveryController } from "../logic/mobileRecovery.controller";
import type { MobileRpcClient } from "../lib/mobileRpc";

function newCommandId() {
  return CommandId.makeUnsafe(crypto.randomUUID());
}

function newMessageId() {
  return MessageId.makeUnsafe(crypto.randomUUID());
}

type AnswersByRequestId = Record<string, Record<string, PendingUserInputDraftAnswer>>;
type QuestionIndexByRequestId = Record<string, number>;

interface MobileThreadCommandInput {
  readonly client: MobileRpcClient | null;
  readonly recovery: MobileRecoveryController | null;
  readonly actionsAvailable: boolean;
  readonly threadId: ThreadId;
  readonly thread: OrchestrationThread | null;
  readonly draftThread: MobileDraftThread | null;
  readonly project: OrchestrationProject | undefined;
  readonly selectedModelSelection: ModelSelection;
  readonly isDraft: boolean;
  readonly prompt: string;
  readonly activePendingUserInput: MobilePendingUserInput | null;
  readonly activeUserInputAnswers: Record<string, PendingUserInputDraftAnswer>;
  readonly activeUserInputQuestionIndex: number;
  readonly setPrompt: Dispatch<SetStateAction<string>>;
  readonly setPendingModelSelection: Dispatch<SetStateAction<ModelSelection | null>>;
  readonly setUserInputAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequestId>>;
  readonly setUserInputQuestionIndexByRequestId: Dispatch<SetStateAction<QuestionIndexByRequestId>>;
  readonly setIsRespondingToUserInput: Dispatch<SetStateAction<boolean>>;
  readonly refetchSnapshot: () => Promise<unknown>;
  readonly refetchThread: () => Promise<unknown>;
}

export function createMobileThreadCommands(input: MobileThreadCommandInput) {
  const refreshAfterCommand = async () => {
    if (input.recovery) {
      await input.recovery.refresh(input.threadId);
      return;
    }
    await Promise.all([input.refetchSnapshot(), input.refetchThread()]);
  };

  const interruptTurn = async () => {
    if (!input.client) return;
    await input.client.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
    });
    await refreshAfterCommand();
  };

  const sendPrompt = async () => {
    if (!input.client || !input.actionsAvailable) return;

    if (input.activePendingUserInput) {
      const progress = derivePendingUserInputProgress(
        input.activePendingUserInput.questions,
        input.activeUserInputAnswers,
        input.activeUserInputQuestionIndex,
      );
      const draftAnswers = { ...input.activeUserInputAnswers };
      if (progress.activeQuestion && input.prompt.trim().length > 0) {
        draftAnswers[progress.activeQuestion.id] = applyMobileUserInputCustomAnswer(
          draftAnswers[progress.activeQuestion.id],
          input.prompt,
        );
      }

      if (progress.isLastQuestion) {
        const answers = resolveMobileUserInputAnswers(input.activePendingUserInput, draftAnswers);
        if (!answers) return;
        input.setIsRespondingToUserInput(true);
        try {
          await input.client.dispatchCommand({
            type: "thread.user-input.respond",
            commandId: newCommandId(),
            threadId: input.threadId,
            requestId: input.activePendingUserInput.requestId,
            answers,
            createdAt: new Date().toISOString(),
          });
          input.setPrompt("");
          input.setUserInputAnswersByRequestId((existing) => {
            const next = { ...existing };
            delete next[input.activePendingUserInput!.requestId];
            return next;
          });
          input.setUserInputQuestionIndexByRequestId((existing) => {
            const next = { ...existing };
            delete next[input.activePendingUserInput!.requestId];
            return next;
          });
          await refreshAfterCommand();
        } finally {
          input.setIsRespondingToUserInput(false);
        }
      } else if (progress.canAdvance) {
        input.setUserInputQuestionIndexByRequestId((existing) => ({
          ...existing,
          [input.activePendingUserInput!.requestId]: input.activeUserInputQuestionIndex + 1,
        }));
        input.setPrompt("");
      }
      return;
    }

    if (input.prompt.trim().length === 0) return;
    const trimmedPrompt = input.prompt.trim();
    const createdAt = new Date().toISOString();
    const messageId = newMessageId();

    if (input.isDraft && input.draftThread && input.project) {
      await input.client.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: input.threadId,
        runtimeMode: input.draftThread.runtimeMode,
        interactionMode: input.draftThread.interactionMode,
        createdAt,
        modelSelection: input.selectedModelSelection,
        bootstrap: buildMobileCreateThreadBootstrap({
          project: input.project,
          promptText: trimmedPrompt,
          createdAt: input.draftThread.createdAt,
          branch: input.draftThread.branch,
          worktreePath: input.draftThread.worktreePath,
          runtimeMode: input.draftThread.runtimeMode,
          interactionMode: input.draftThread.interactionMode,
          modelSelection: input.selectedModelSelection,
        }),
        message: {
          messageId,
          role: "user",
          text: trimmedPrompt,
          attachments: [],
        },
      });
      clearMobileDraftThread(input.threadId);
      input.setPendingModelSelection(null);
      input.setPrompt("");
      await refreshAfterCommand();
      return;
    }

    if (!input.thread) return;
    await input.client.dispatchCommand({
      type: "thread.message.submit",
      commandId: newCommandId(),
      threadId: input.threadId,
      createdAt,
      delivery: "auto",
      message: { messageId, text: trimmedPrompt },
    });
    input.setPrompt("");
    await refreshAfterCommand();
  };

  const respondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (!input.client || !input.actionsAvailable) return;
    await input.client.dispatchCommand({
      type: "thread.approval.respond",
      commandId: newCommandId(),
      threadId: input.threadId,
      requestId,
      decision,
      createdAt: new Date().toISOString(),
    });
    await refreshAfterCommand();
  };

  return { interruptTurn, respondToApproval, sendPrompt } as const;
}
