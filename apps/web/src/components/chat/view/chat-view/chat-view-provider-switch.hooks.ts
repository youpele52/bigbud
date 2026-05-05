import type { ModelSelection, ProviderKind } from "@bigbud/contracts";
import { useCallback, useState } from "react";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { resolveAppModelSelection, resolveSelectableProvider } from "~/models/provider";
import { providerSupportsSubProviderID } from "../ChatView.modelSelection.logic";
import { useThreadActions } from "~/hooks/useThreadActions";

export interface PendingProviderSwitchConfirmation {
  targetLabel: string;
  nextModelSelection: ModelSelection;
}

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
  const { forkThread } = useThreadActions();

  const branchThreadForProviderChange = useCallback(
    async (nextModelSelection: ModelSelection) => {
      if (!base.activeThread || !base.isServerThread) {
        runtime.scheduleComposerFocus();
        return;
      }

      const forkedThreadId = await forkThread(base.activeThread.id, {
        modelSelection: nextModelSelection,
        navigateToFork: true,
      });

      if (forkedThreadId) {
        base.setStickyComposerModelSelection(nextModelSelection);
      }

      runtime.scheduleComposerFocus();
    },
    [base, forkThread, runtime],
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
    setPendingProviderSwitchConfirmation(null);
    void branchThreadForProviderChange(nextModelSelection);
  }, [branchThreadForProviderChange, pendingProviderSwitchConfirmation]);

  const onDismissPendingProviderSwitch = useCallback(() => {
    setPendingProviderSwitchConfirmation(null);
    runtime.scheduleComposerFocus();
  }, [runtime]);

  return {
    pendingProviderSwitchConfirmation,
    onProviderModelSelect,
    onConfirmPendingProviderSwitch,
    onDismissPendingProviderSwitch,
  };
}
