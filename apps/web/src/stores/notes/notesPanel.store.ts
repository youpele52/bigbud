import { type NoteId } from "@bigbud/contracts";
import { create } from "zustand";

type NotesScope = "project" | "global";

interface NotesPanelState {
  open: boolean;
  scope: NotesScope;
  selectedNoteId: NoteId | null;
  previewMode: boolean;
  setOpen: (open: boolean) => void;
  setScope: (scope: NotesScope) => void;
  setSelectedNoteId: (noteId: NoteId | null) => void;
  setPreviewMode: (previewMode: boolean) => void;
}

export const useNotesPanelStore = create<NotesPanelState>((set) => ({
  open: false,
  scope: "project",
  selectedNoteId: null,
  previewMode: true,
  setOpen: (open) => set({ open }),
  setScope: (scope) => set({ scope }),
  setSelectedNoteId: (selectedNoteId) => set({ selectedNoteId }),
  setPreviewMode: (previewMode) => set({ previewMode }),
}));
