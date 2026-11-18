import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { digestMaterializationRequest } from "../../../stores/materialization/materializationRequestDigest";
import {
  classifyMaterializationFailure,
  completeMaterialization,
  markMaterializationDispatching,
  prepareMaterializationForSend,
} from "./ChatView.sendTurn.materialization";

/** Plan follow-ups use the same durable per-thread attempt as ordinary composer sends. */
export async function dispatchPlanFollowUp(input: {
  api: Pick<NativeApi, "orchestration">;
  projectId: ProjectId;
  command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
  beforeDispatch: (messageId: MessageId) => Promise<void>;
  setThreadError: (threadId: ThreadId, error: string | null) => void;
}): Promise<boolean> {
  const { command, api } = input;
  const requestDigest = await digestMaterializationRequest({
    kind: "plan-follow-up",
    threadId: command.threadId,
    projectId: input.projectId,
    message: { text: command.message.text, attachments: command.message.attachments },
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    sourceProposedPlan: command.sourceProposedPlan,
  });
  const gate = await prepareMaterializationForSend({
    api,
    isDraft: false,
    threadId: command.threadId,
    projectId: input.projectId,
    commandId: command.commandId,
    messageId: command.message.messageId,
    kind: "turn",
    createdAt: command.createdAt,
    requestDigest,
    setThreadError: input.setThreadError,
  });
  if (!gate.proceed) return gate.accepted;
  const attempt = gate.attempt;
  try {
    await input.beforeDispatch(attempt?.messageId ?? command.message.messageId);
    await markMaterializationDispatching(attempt);
    const result = await api.orchestration.dispatchCommand({
      ...command,
      commandId: attempt?.commandId ?? command.commandId,
      message: { ...command.message, messageId: attempt?.messageId ?? command.message.messageId },
    });
    await completeMaterialization({ threadId: command.threadId }, attempt, result.sequence);
    return true;
  } catch (error) {
    const outcome = await classifyMaterializationFailure(api, attempt);
    if (outcome === "accepted") return true;
    if (outcome === "ambiguous") {
      throw new Error(
        "Your plan follow-up is safe. Retry to check the previous outcome without duplicating it.",
        { cause: error },
      );
    }
    throw error;
  }
}
