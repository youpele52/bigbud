import {
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@bigbud/contracts";

import { readNativeApi } from "../../../../rpc/nativeApi";
import { modelSelectionsEqual } from "../ChatView.modelSelection.logic";
import { newCommandId } from "~/lib/utils";

export async function persistThreadSettingsForNextTurn(input: {
  threadId: ThreadId;
  createdAt: string;
  modelSelection?: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  serverThread:
    | {
        modelSelection: ModelSelection;
        runtimeMode: RuntimeMode;
        interactionMode: ProviderInteractionMode;
      }
    | null
    | undefined;
}) {
  if (!input.serverThread) {
    return;
  }
  const api = readNativeApi();
  if (!api) {
    return;
  }

  if (
    input.modelSelection !== undefined &&
    !modelSelectionsEqual(input.modelSelection, input.serverThread.modelSelection)
  ) {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      modelSelection: input.modelSelection,
    });
  }

  if (input.runtimeMode !== input.serverThread.runtimeMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.runtime-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      createdAt: input.createdAt,
    });
  }

  if (input.interactionMode !== input.serverThread.interactionMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      interactionMode: input.interactionMode,
      createdAt: input.createdAt,
    });
  }
}
