import { create } from "zustand";

import type { RightPanelTabId } from "../rightPanel/rightPanelTabs.store";

interface BrowserCloseConfirmationState {
  readonly tabIds: ReadonlyArray<RightPanelTabId>;
  request: (tabIds: ReadonlyArray<RightPanelTabId>) => void;
  dismiss: () => void;
}

export const useBrowserCloseConfirmationStore = create<BrowserCloseConfirmationState>((set) => ({
  tabIds: [],
  request: (tabIds) => set({ tabIds: [...new Set(tabIds)] }),
  dismiss: () => set({ tabIds: [] }),
}));
