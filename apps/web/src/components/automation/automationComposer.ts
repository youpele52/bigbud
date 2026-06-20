import { type ModelSelection, type ThreadId } from "@bigbud/contracts";

import { newCommandId } from "~/lib/utils";
import { type ComposerThreadDraftState } from "~/stores/composer";

import { readNativeApi } from "../../rpc/nativeApi";

export function resolveAutomationComposerModelSelection(
  draft: Pick<ComposerThreadDraftState, "activeProvider" | "modelSelectionByProvider">,
): ModelSelection | null {
  if (draft.activeProvider) {
    return draft.modelSelectionByProvider[draft.activeProvider] ?? null;
  }

  const selections = Object.values(draft.modelSelectionByProvider);
  return selections[0] ?? null;
}

export async function syncAutomationTargetThreadModelSelection(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  input: {
    readonly modelSelection: ModelSelection | null;
    readonly targetThreadId: ThreadId;
  },
) {
  if (!input.modelSelection) {
    return;
  }

  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: input.targetThreadId,
    modelSelection: input.modelSelection,
  });
}
