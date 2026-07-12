import { useState } from "react";

import { getWsRpcClient } from "~/rpc/wsRpcClient";
import { closeBrowserTabsAfterRevocation } from "~/stores/browser/browserPanel.actions";
import { useBrowserCloseConfirmationStore } from "~/stores/browser/browserCloseConfirmation.store";
import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";
import { getVisibleBrowserRendererId } from "./BrowserAgentControlBridge";

export function BrowserCloseConfirmation() {
  const tabIds = useBrowserCloseConfirmationStore((state) => state.tabIds);
  const dismiss = useBrowserCloseConfirmationStore((state) => state.dismiss);
  const [busy, setBusy] = useState(false);
  const controlledTabIds = tabIds.filter(
    (tabId) => useBrowserPanelStore.getState().tabsById[tabId]?.agentLease,
  );

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await Promise.all(
        controlledTabIds.map(async (tabId) => {
          const lease = useBrowserPanelStore.getState().tabsById[tabId]?.agentLease;
          if (!lease) return;
          await getWsRpcClient().browser.revokeLease({
            leaseId: lease.leaseId,
            rendererId: getVisibleBrowserRendererId(),
            tabId,
          });
          useBrowserPanelStore.getState().clearAgentLease(tabId);
        }),
      );
      closeBrowserTabsAfterRevocation(tabIds);
      dismiss();
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

  const controlledTabCount = controlledTabIds.length;
  const plural = controlledTabCount === 1 ? "tab" : "tabs";

  return (
    <AlertDialog open={tabIds.length > 0} onOpenChange={(open) => !open && !busy && dismiss()}>
      <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
        <ConfirmationPanel
          title={`Close agent-controlled ${plural}?`}
          description={`The agent will lose control of ${controlledTabCount} browser ${plural}, and any action in progress will stop.`}
          cancelLabel="Cancel"
          confirmLabel="Stop control and close"
          confirmVariant="destructive"
          busy={busy}
          onCancel={dismiss}
          onConfirm={() => void handleConfirm()}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
