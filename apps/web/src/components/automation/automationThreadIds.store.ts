import { create } from "zustand";

interface AutomationThreadIdsStoreState {
  readonly revision: number;
  readonly invalidate: () => void;
}

export const useAutomationThreadIdsStore = create<AutomationThreadIdsStoreState>((set) => ({
  revision: 0,
  invalidate: () => {
    set((state) => ({ revision: state.revision + 1 }));
  },
}));

export function invalidateAutomationThreadIds() {
  useAutomationThreadIdsStore.getState().invalidate();
}
