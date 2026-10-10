import type { ProviderInteractionMode, RuntimeMode } from "@bigbud/contracts";
import { useCallback, useState } from "react";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

/** Owns user-initiated access and interaction mode changes in the composer. */
export function useChatViewRuntimeComposerModes({
  base,
  thread,
  scheduleComposerFocus,
}: {
  base: ChatViewBaseState;
  thread: ChatViewThreadDerivedState;
  scheduleComposerFocus: () => void;
}) {
  const [accessModeChangeId, setAccessModeChangeId] = useState(0);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === base.runtimeMode) return;
      setAccessModeChangeId((changeId) => changeId + 1);
      base.setComposerDraftRuntimeMode(base.threadId, mode);
      if (base.isLocalDraftThread) {
        base.setDraftThreadContext(base.threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [base, scheduleComposerFocus],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === base.interactionMode) return;
      base.setComposerDraftInteractionMode(base.threadId, mode);
      if (base.isLocalDraftThread) {
        base.setDraftThreadContext(base.threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [base, scheduleComposerFocus],
  );

  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(base.interactionMode === "plan" ? "default" : "plan");
  }, [base.interactionMode, handleInteractionModeChange]);

  const togglePlanCard = useCallback(() => {
    base.setPlanCardOpen((open) => {
      if (open) {
        base.planCardDismissedForTurnRef.current =
          thread.activePlan?.turnId ?? thread.cardProposedPlan?.turnId ?? "__dismissed__";
      } else {
        base.planCardDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [base, thread.activePlan?.turnId, thread.cardProposedPlan?.turnId]);

  return {
    accessModeChangeId,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    toggleInteractionMode,
    togglePlanCard,
  };
}
