import { useEffect, useRef, useState } from "react";

import { getWsRpcClient } from "~/rpc/wsRpcClient";
import { confirmBrowserClose } from "~/stores/browser/browserPanel.actions";
import { useBrowserCloseConfirmationStore } from "~/stores/browser/browserCloseConfirmation.store";
import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { getBrowserTabName } from "~/stores/browser/browserTabCapacity";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";
import { getVisibleBrowserRendererId } from "./BrowserAgentControlBridge";

export function BrowserCloseConfirmation() {
  const request = useBrowserCloseConfirmationStore((state) => state.current);
  const dismiss = useBrowserCloseConfirmationStore((state) => state.dismiss);
  const tabsById = useBrowserPanelStore((state) => (request ? state.tabsById : null));
  const [busy, setBusy] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const tabIds = request?.tabIds ?? [];
  const leasedTabs = tabIds.flatMap((tabId) => {
    const tab = tabsById?.[tabId];
    return tab?.agentLease ? [{ tab, leaseId: tab.agentLease.leaseId }] : [];
  });

  useEffect(() => {
    if (request && !busy) cancelButtonRef.current?.focus();
  }, [request, busy]);

  const handleConfirm = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      const leaseIds = new Set(leasedTabs.map(({ leaseId }) => leaseId));
      await confirmBrowserClose(request, leaseIds, (input) =>
        getWsRpcClient().browser.revokeLease({
          ...input,
          rendererId: getVisibleBrowserRendererId(),
        }),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not close the agent-controlled browser tab",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const controlledTabCount = leasedTabs.length;
  const plural = controlledTabCount === 1 ? "tab" : "tabs";
  const controlWarning = `The agent will lose control of ${controlledTabCount} browser ${plural}, and any action in progress will stop.`;
  const overflow = request?.kind === "overflow";
  const hasAgentControl = controlledTabCount > 0;
  const blockedGame = overflow && request.continuation.kind === "game" && hasAgentControl;
  const namedTabs = blockedGame
    ? leasedTabs.map(({ tab }) => tab)
    : tabIds.map((id) => tabsById?.[id]);
  const names = namedTabs.map((tab) => `“${getBrowserTabName(tab)}”`).join(", ");
  const manualCloseTitle = hasAgentControl
    ? `Close agent-controlled ${plural}?`
    : "Close browser tabs?";

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && !busy && dismiss()}>
      <AlertDialogPopup
        className="max-w-sm p-0"
        bottomStickOnMobile={false}
        initialFocus={cancelButtonRef}
      >
        <ConfirmationPanel
          title={overflow ? "Make room for a new browser tab?" : manualCloseTitle}
          description={
            blockedGame ? (
              `Games can’t close ${names} while under agent control. Review the replacement again or cancel.`
            ) : overflow ? (
              <>
                {request.unknownOrder ? "The browser couldn't determine the oldest tab. " : ""}
                Continuing will close {names} and open your new tab.
                {hasAgentControl ? ` ${controlWarning}` : ""}
              </>
            ) : hasAgentControl ? (
              controlWarning
            ) : (
              `Continuing will close ${names}.`
            )
          }
          cancelLabel="Cancel"
          confirmLabel={
            blockedGame
              ? "Review replacement"
              : overflow
                ? "Continue"
                : hasAgentControl
                  ? "Stop control and close"
                  : "Close"
          }
          confirmVariant={blockedGame ? "default" : "destructive"}
          cancelButtonRef={cancelButtonRef}
          busy={busy}
          onCancel={dismiss}
          onConfirm={() => void handleConfirm()}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
