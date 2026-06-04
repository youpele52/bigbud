import type { ThreadId } from "@bigbud/contracts";
import type { NavigateFn } from "@tanstack/react-router";

import { requestRightPanel } from "~/stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";

export function openDiffPanel(navigate: NavigateFn, threadId: ThreadId | null | undefined) {
  if (!threadId) {
    return;
  }

  requestRightPanel("diff");
  useRightPanelTabsStore.getState().openTab("diff");

  void navigate({
    to: "/$threadId",
    params: { threadId },
    replace: true,
    search: (previous) => ({ ...previous, diff: "1" }),
  });
}
