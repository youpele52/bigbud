import { create } from "zustand";

import type { RightPanelTabId } from "../rightPanel/rightPanelTabs.store";

export interface BrowserClosePlan {
  readonly limit: number;
  readonly tabIds: ReadonlyArray<RightPanelTabId>;
}

type OverflowContinuation =
  | { readonly kind: "browser"; readonly url: string; readonly draftTabId?: RightPanelTabId }
  | {
      readonly kind: "game";
      readonly resume: (plan: BrowserClosePlan) => void;
      readonly onLeaseConflict: (limit: number) => void;
    };

export type BrowserCloseRequest =
  | { readonly kind: "close"; readonly tabIds: ReadonlyArray<RightPanelTabId> }
  | {
      readonly kind: "overflow";
      readonly tabIds: ReadonlyArray<RightPanelTabId>;
      readonly unknownOrder: boolean;
      readonly continuation: OverflowContinuation;
    };

interface BrowserCloseConfirmationState {
  readonly current: BrowserCloseRequest | null;
  request: (request: BrowserCloseRequest) => void;
  dismiss: () => void;
}

export const useBrowserCloseConfirmationStore = create<BrowserCloseConfirmationState>((set) => ({
  current: null,
  request: (current) => set({ current }),
  dismiss: () => set({ current: null }),
}));
