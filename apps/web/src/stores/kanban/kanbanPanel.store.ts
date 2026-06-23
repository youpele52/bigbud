import { type KanbanCardId } from "@bigbud/contracts";
import { create } from "zustand";

type KanbanScope = "project" | "global";

interface KanbanPanelState {
  open: boolean;
  scope: KanbanScope;
  selectedCardId: KanbanCardId | null;
  previewMode: boolean;
  setOpen: (open: boolean) => void;
  setScope: (scope: KanbanScope) => void;
  setSelectedCardId: (cardId: KanbanCardId | null) => void;
  setPreviewMode: (previewMode: boolean) => void;
}

export const useKanbanPanelStore = create<KanbanPanelState>((set) => ({
  open: false,
  scope: "project",
  selectedCardId: null,
  previewMode: false,
  setOpen: (open) => set({ open }),
  setScope: (scope) => set({ scope }),
  setSelectedCardId: (selectedCardId) => set({ selectedCardId }),
  setPreviewMode: (previewMode) => set({ previewMode }),
}));
