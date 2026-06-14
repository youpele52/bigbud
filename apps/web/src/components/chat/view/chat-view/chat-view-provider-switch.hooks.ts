import type { ModelSelection, ProviderKind } from "@bigbud/contracts";
import { useCallback, useState } from "react";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { resolveAppModelSelection, resolveSelectableProvider } from "~/models/provider";
import { providerSupportsSubProviderID } from "../ChatView.modelSelection.logic";
import { useThreadActions } from "~/hooks/useThreadActions";
import { dispatchHandoffSkillTurn, HandoffError, waitForHandoffSummary } from "~/lib/handoff";
import { newMessageId } from "~/lib/utils";
import { toastManager } from "~/components/ui/toast";

export interface PendingProviderSwitchConfirmation {
  targetLabel: string;
  nextModelSelection: ModelSelection;
}

export type ProviderSwitchBranchMode = "handoff" | "conversation";

interface UseChatViewProviderSwitchInput {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  runtime: ChatViewRuntimeState;
}

function providerSwitchTargetLabel(provider: ProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "copilot":
      return "Copilot";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    default:
      return "Codex";
  }
}

export function useChatViewProviderSwitch({
  base,
  composer,
  runtime,
}: UseChatViewProviderSwitchInput) {
  const [pendingProviderSwitchConfirmation, setPendingProviderSwitchConfirmation] =
    useState<PendingProviderSwitchConfirmation | null>(null);
  const [branchMode, setBranchMode] = useState<ProviderSwitchBranchMode>("handoff");
  const [isGeneratingHandoff, setIsGeneratingHandoff] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const { branchThread } = useThreadActions();

  const branchThreadForProviderChange = useCallback(
    async (nextModelSelection: ModelSelection) => {
      if (!base.activeThread || !base.isServerThread) {
        runtime.scheduleComposerFocus();
        return;
      }

      const branchedThreadId = await branchThread(base.activeThread.id, {
        modelSelection: nextModelSelection,
        navigateToBranch: true,
      });

      if (branchedThreadId) {
        base.setStickyComposerModelSelection(nextModelSelection);
      }

      runtime.scheduleComposerFocus();
    },
    [base, branchThread, runtime],
  );

  const branchThreadWithHandoff = useCallback(
    async (nextModelSelection: ModelSelection) => {
      if (!base.activeThread || !base.isServerThread) {
        runtime.scheduleComposerFocus();
        return;
      }

      setIsGeneratingHandoff(true);
      setHandoffError(null);

      try {
        await dispatchHandoffSkillTurn({
          threadId: base.activeThread.id,
          runtimeMode: base.activeThread.runtimeMode,
          interactionMode: base.activeThread.interactionMode,
        });
        const handoffSummary = await waitForHandoffSummary(base.activeThread.id);
        const handoffSeedMessage = {
          id: newMessageId(),
          role: "assistant" as const,
          text: handoffSummary,
          turnId: null,
          streaming: false as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const branchedThreadId = await branchThread(base.activeThread.id, {
          modelSelection: nextModelSelection,
          navigateToBranch: true,
          seedMessages: [handoffSeedMessage],
        });

        if (branchedThreadId) {
          base.setStickyComposerModelSelection(nextModelSelection);
        }
      } catch (err) {
        const message = err instanceof HandoffError ? err.message : "Could not generate handoff.";
        setHandoffError(message);
        toastManager.add({
          type: "error",
          title: "Handoff failed",
          description: message,
        });
        setIsGeneratingHandoff(false);
        return;
      }

      setIsGeneratingHandoff(false);
      setPendingProviderSwitchConfirmation(null);
      runtime.scheduleComposerFocus();
    },
    [base, branchThread, runtime],
  );

  const onProviderModelSelect = useCallback(
    async (provider: ProviderKind, model: string, subProviderID?: string) => {
      if (!base.activeThread) return;
      const resolvedProvider = resolveSelectableProvider(composer.providerStatuses, provider);
      const resolvedModel = resolveAppModelSelection(
        resolvedProvider,
        base.settings,
        composer.providerStatuses,
        model,
      );
      const matchedServerModel = composer.modelOptionsByProvider[resolvedProvider]?.find(
        (entry) =>
          entry.slug === resolvedModel &&
          (!providerSupportsSubProviderID(resolvedProvider) ||
            entry.subProviderID === subProviderID),
      );
      const nextModelSelection: ModelSelection = {
        provider: resolvedProvider,
        model: resolvedModel,
        ...(providerSupportsSubProviderID(resolvedProvider) && matchedServerModel?.subProviderID
          ? { subProviderID: matchedServerModel.subProviderID }
          : {}),
      };
      const boundProvider = composer.sessionProvider ?? composer.threadProvider;
      const shouldBranchOnProviderChange =
        composer.hasThreadStarted && boundProvider !== null && resolvedProvider !== boundProvider;

      if (shouldBranchOnProviderChange) {
        setBranchMode("handoff");
        setHandoffError(null);
        setPendingProviderSwitchConfirmation({
          targetLabel: providerSwitchTargetLabel(resolvedProvider),
          nextModelSelection,
        });
        return;
      }

      setPendingProviderSwitchConfirmation(null);
      base.setComposerDraftModelSelection(base.activeThread.id, nextModelSelection);
      base.setStickyComposerModelSelection(nextModelSelection);
      runtime.scheduleComposerFocus();
    },
    [base, composer, runtime],
  );

  const onConfirmPendingProviderSwitch = useCallback(() => {
    if (!pendingProviderSwitchConfirmation) {
      return;
    }

    const nextModelSelection = pendingProviderSwitchConfirmation.nextModelSelection;

    if (branchMode === "conversation") {
      setPendingProviderSwitchConfirmation(null);
      void branchThreadForProviderChange(nextModelSelection);
      return;
    }

    void branchThreadWithHandoff(nextModelSelection);
  }, [
    branchMode,
    branchThreadForProviderChange,
    branchThreadWithHandoff,
    pendingProviderSwitchConfirmation,
  ]);

  const onDismissPendingProviderSwitch = useCallback(() => {
    setPendingProviderSwitchConfirmation(null);
    setHandoffError(null);
    setIsGeneratingHandoff(false);
    runtime.scheduleComposerFocus();
  }, [runtime]);

  return {
    pendingProviderSwitchConfirmation,
    branchMode,
    setBranchMode,
    isGeneratingHandoff,
    handoffError,
    onProviderModelSelect,
    onConfirmPendingProviderSwitch,
    onDismissPendingProviderSwitch,
  };
}
