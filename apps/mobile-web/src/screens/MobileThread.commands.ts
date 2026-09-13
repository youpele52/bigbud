import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type ClientOrchestrationCommand,
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

import { resolveMobileUserInputAnswers } from "../components/threads/thread/composer/MobileComposer";
import type { MobilePendingUserInput } from "../lib/mobileModels";
import type { MobileDraftThread } from "../lib/mobileDraftThread";
import { buildMobileCreateThreadBootstrap } from "../logic/mobileNewThread.logic";
import type { MobileRecoveryController } from "../logic/mobileRecovery.controller";
import type { MobileRpcClient } from "../lib/mobileRpc";
import type { MobileCommandDeliveryController } from "../lib/mobileCommandDelivery";

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
  readonly setPendingModelSelection: Dispatch<SetStateAction<ModelSelection | null>>;
  readonly setUserInputAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequestId>>;
  readonly setUserInputQuestionIndexByRequestId: Dispatch<SetStateAction<QuestionIndexByRequestId>>;
  readonly setIsRespondingToUserInput: Dispatch<SetStateAction<boolean>>;
  readonly refetchSnapshot: () => Promise<unknown>;
  readonly refetchThread: () => Promise<unknown>;
  readonly delivery: MobileCommandDeliveryController;
  readonly decisionDelivery?: MobileCommandDeliveryController;
  readonly revision: number;
  readonly clearSubmittedIfRevision: (submittedRevision: number) => void;
  readonly clearNewThread: () => void;
}

export function buildMobileExistingThreadTurnStartCommand(input: {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly thread: OrchestrationThread;
  readonly modelSelection: ModelSelection;
  readonly text: string;
  readonly createdAt: string;
}) {
  return {
    type: "thread.turn.start" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    createdAt: input.createdAt,
    modelSelection: input.modelSelection,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: input.text,
      attachments: [],
    },
  } satisfies ClientOrchestrationCommand;
}

export function createMobileThreadCommands(input: MobileThreadCommandInput) {
  const refreshAfterCommand = async () => {
    if (input.recovery) {
      await input.recovery.refresh(input.threadId);
      return;
    }
    await Promise.all([input.refetchSnapshot(), input.refetchThread()]);
  };

  const reconcileOutcome = async (
    commandId: ClientOrchestrationCommand["commandId"],
    delivery = input.delivery,
  ) => {
    if (!input.client) return delivery.getState();
    return delivery.reconcile(async () => {
      const outcome = await input.client!.getMobileCommandOutcome({
        commandId,
        threadId: input.threadId,
      });
      if (outcome.status === "accepted") return { status: "accepted" as const };
      if (outcome.status === "rejected") {
        return { status: "rejected" as const, reason: outcome.reason };
      }
      return { status: "unknown" as const };
    });
  };

  const dispatchWithDelivery = async (
    command: ClientOrchestrationCommand,
    submittedRevision: number,
    delivery = input.delivery,
  ) => {
    if (!input.client) return null;
    let state = await delivery.submit({
      command,
      dispatch: (submittedCommand) => input.client!.dispatchCommand(submittedCommand),
      submittedRevision,
    });
    if (state.status === "uncertain") state = await reconcileOutcome(command.commandId, delivery);
    if (state.status === "accepted") {
      const operationRevision = state.operation?.submittedRevision;
      if (delivery === input.delivery && operationRevision !== undefined) {
        input.clearSubmittedIfRevision(operationRevision);
      }
      await refreshAfterCommand();
    } else if (state.status === "rejected") {
      await refreshAfterCommand();
    }
    return state;
  };

  const checkDelivery = async () => {
    const commandId = input.delivery.getState().operation?.command.commandId;
    if (!commandId) return input.delivery.getState();
    const state = await reconcileOutcome(commandId);
    if (state.status === "accepted" || state.status === "rejected") {
      await refreshAfterCommand();
    }
    return state;
  };

  const retryDelivery = async () => {
    if (!input.client) return input.delivery.getState();
    const state = await input.delivery.retrySameOperation((command) =>
      input.client!.dispatchCommand(command),
    );
    if (state.status === "accepted") {
      const operationRevision = state.operation?.submittedRevision;
      if (operationRevision !== undefined) input.clearSubmittedIfRevision(operationRevision);
      await refreshAfterCommand();
    } else if (state.status === "rejected") {
      await refreshAfterCommand();
    }
    return state;
  };

  const interruptTurn = async () => {
    if (!input.client) return;
    const command = {
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
    } satisfies ClientOrchestrationCommand;
    await dispatchWithDelivery(command, input.revision, input.decisionDelivery ?? input.delivery);
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

      if (progress.isLastQuestion) {
        const answers = resolveMobileUserInputAnswers(input.activePendingUserInput, draftAnswers);
        if (!answers) return;
        input.setIsRespondingToUserInput(true);
        try {
          const command = {
            type: "thread.user-input.respond",
            commandId: newCommandId(),
            threadId: input.threadId,
            requestId: input.activePendingUserInput.requestId,
            answers,
            createdAt: new Date().toISOString(),
          } satisfies ClientOrchestrationCommand;
          const state = await dispatchWithDelivery(
            command,
            input.revision,
            input.decisionDelivery ?? input.delivery,
          );
          if (state?.status === "accepted") {
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
          }
        } finally {
          input.setIsRespondingToUserInput(false);
        }
      } else if (progress.canAdvance) {
        input.setUserInputQuestionIndexByRequestId((existing) => ({
          ...existing,
          [input.activePendingUserInput!.requestId]: input.activeUserInputQuestionIndex + 1,
        }));
      }
      return;
    }

    if (input.prompt.trim().length === 0) return;
    const trimmedPrompt = input.prompt.trim();
    const createdAt = new Date().toISOString();
    const messageId = newMessageId();
    const commandId = newCommandId();

    if (input.isDraft && input.draftThread && input.project) {
      const command = {
        type: "thread.turn.start",
        commandId,
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
      } satisfies ClientOrchestrationCommand;
      const state = await dispatchWithDelivery(command, input.revision);
      if (state?.status === "accepted") {
        input.clearNewThread();
        input.setPendingModelSelection(null);
      }
      return;
    }

    if (!input.thread) return;
    const command = buildMobileExistingThreadTurnStartCommand({
      commandId,
      createdAt,
      messageId,
      modelSelection: input.selectedModelSelection,
      text: trimmedPrompt,
      thread: input.thread,
      threadId: input.threadId,
    });
    await dispatchWithDelivery(command, input.revision);
  };

  const respondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (!input.client || !input.actionsAvailable) return;
    const command = {
      type: "thread.approval.respond",
      commandId: newCommandId(),
      threadId: input.threadId,
      requestId,
      decision,
      createdAt: new Date().toISOString(),
    } satisfies ClientOrchestrationCommand;
    await dispatchWithDelivery(command, input.revision, input.decisionDelivery ?? input.delivery);
  };

  return { checkDelivery, interruptTurn, respondToApproval, retryDelivery, sendPrompt } as const;
}
