import { NoteId, type ProjectId } from "@bigbud/contracts";
import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import { openPathInPreferredApp } from "~/models/editor";
import { ensureNativeApi } from "~/rpc/nativeApi";

import { type NotesListItem } from "./NotesPanel.list";

interface UseNotesPanelActionsInput {
  readonly copyToClipboard: (text: string) => void;
  readonly getNoteContentFromCache: (noteId: NoteId) => string | undefined;
  readonly loadNotes: (nextSelectedNoteId?: string | null) => Promise<void>;
  readonly projectId: ProjectId | null;
  readonly renamingCommittedRef: MutableRefObject<boolean>;
  readonly renamingInputRef: RefObject<HTMLInputElement | null>;
  readonly resolvedScope: "project" | "global";
  readonly selectedNote: NotesListItem | null;
  readonly selectedNoteId: NoteId | null;
  readonly setError: (value: string | null) => void;
  readonly setNoteContentsById: Dispatch<SetStateAction<Record<NoteId, string>>>;
  readonly setNotes: Dispatch<SetStateAction<ReadonlyArray<NotesListItem>>>;
  readonly setPreviewMode: (value: boolean) => void;
  readonly setRenamingNoteId: Dispatch<SetStateAction<NoteId | null>>;
  readonly setRenamingTitle: (value: string) => void;
  readonly setSavedContent: (value: string) => void;
  readonly setSaving: (value: boolean) => void;
  readonly setSelectedNoteId: (value: NoteId | null) => void;
}

export function useNotesPanelActions(input: UseNotesPanelActionsInput) {
  const getNoteContent = useCallback(
    async (noteId: NoteId) => {
      const existingContent = input.getNoteContentFromCache(noteId);
      if (existingContent !== undefined) {
        return existingContent;
      }
      const note = await ensureNativeApi().notes.get({ noteId });
      input.setNoteContentsById((current) => ({
        ...current,
        [note.noteId]: note.content,
      }));
      return note.content;
    },
    [input],
  );

  const handleCreate = useCallback(async () => {
    input.setSaving(true);
    input.setError(null);
    try {
      const created = await ensureNativeApi().notes.create({
        projectId: input.resolvedScope === "project" ? input.projectId : null,
        title: "Untitled note",
        content: "# Untitled note\n",
      });
      input.setNoteContentsById((current) => ({
        ...current,
        [created.noteId]: created.content,
      }));
      await input.loadNotes(created.noteId);
      input.setPreviewMode(false);
    } catch (nextError) {
      input.setError(nextError instanceof Error ? nextError.message : "Failed to create note.");
    } finally {
      input.setSaving(false);
    }
  }, [input]);

  const deleteNote = useCallback(
    async (noteId: NoteId, title: string) => {
      const api = ensureNativeApi();
      const confirmed = await api.dialogs.confirm(`Delete note "${title}"?`);
      if (!confirmed) return;

      input.setSaving(true);
      input.setError(null);
      try {
        await api.notes.delete({ noteId });
        input.setNoteContentsById((current) => {
          const next = { ...current };
          delete next[noteId];
          return next;
        });
        await input.loadNotes(input.selectedNoteId === noteId ? undefined : input.selectedNoteId);
      } catch (nextError) {
        input.setError(nextError instanceof Error ? nextError.message : "Failed to delete note.");
      } finally {
        input.setSaving(false);
      }
    },
    [input],
  );

  const commitRename = useCallback(
    async (noteId: NoteId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        input.setRenamingNoteId((current) => {
          if (current !== noteId) return current;
          if (input.renamingInputRef.current) {
            input.renamingInputRef.current = null;
          }
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0 || trimmed === originalTitle) {
        finishRename();
        return;
      }

      try {
        const content = await getNoteContent(noteId);
        const updated = await ensureNativeApi().notes.update({
          noteId,
          title: trimmed,
          content,
        });
        if (input.selectedNoteId === noteId && updated.noteId !== noteId) {
          input.setSelectedNoteId(updated.noteId);
        }
        input.setNotes((current) =>
          current.map((note) => (note.noteId === noteId ? updated : note)),
        );
        input.setNoteContentsById((current) => {
          const next = { ...current };
          delete next[noteId];
          next[updated.noteId] = updated.content;
          return next;
        });
      } catch (nextError) {
        input.setError(nextError instanceof Error ? nextError.message : "Failed to rename note.");
      }

      finishRename();
    },
    [getNoteContent, input],
  );

  const handleDuplicate = useCallback(
    async (note: NotesListItem) => {
      try {
        const created = await ensureNativeApi().notes.create({
          projectId: note.projectId as ProjectId | null,
          title: `Copy of ${note.title}`,
          content: await getNoteContent(note.noteId),
        });
        input.setNoteContentsById((current) => ({
          ...current,
          [created.noteId]: created.content,
        }));
        await input.loadNotes(created.noteId);
      } catch (nextError) {
        input.setError(
          nextError instanceof Error ? nextError.message : "Failed to duplicate note.",
        );
      }
    },
    [getNoteContent, input],
  );

  const handleNoteContextMenu = useCallback(
    async (note: NotesListItem, position: { x: number; y: number }) => {
      const api = ensureNativeApi();
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename note" },
          { id: "copy", label: "Copy note" },
          { id: "copy-path", label: "Copy path" },
          { id: "open-externally", label: "Open externally" },
          { id: "duplicate", label: "Duplicate note" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        input.setSelectedNoteId(note.noteId);
        input.setRenamingNoteId(note.noteId);
        input.setRenamingTitle(note.title);
        input.renamingCommittedRef.current = false;
        return;
      }
      if (clicked === "copy") {
        input.copyToClipboard(await getNoteContent(note.noteId));
        return;
      }
      if (clicked === "copy-path") {
        input.copyToClipboard(note.absolutePath);
        return;
      }
      if (clicked === "open-externally") {
        await openPathInPreferredApp(api, note.absolutePath);
        return;
      }
      if (clicked === "duplicate") {
        await handleDuplicate(note);
        return;
      }
      if (clicked === "delete") {
        await deleteNote(note.noteId, note.title);
      }
    },
    [deleteNote, getNoteContent, handleDuplicate, input],
  );

  const handleSave = useCallback(
    async (nextContent: string) => {
      if (!input.selectedNoteId) return;
      input.setSaving(true);
      input.setError(null);
      try {
        const updated = await ensureNativeApi().notes.update({
          noteId: input.selectedNoteId,
          content: nextContent,
          ...(input.selectedNote ? { expectedUpdatedAt: input.selectedNote.updatedAt } : {}),
        });
        if (updated.noteId !== input.selectedNoteId) {
          input.setSelectedNoteId(updated.noteId);
        }
        input.setNotes((current) =>
          current.map((note) => (note.noteId === input.selectedNoteId ? updated : note)),
        );
        input.setSavedContent(updated.content);
        input.setNoteContentsById((current) => {
          const next = { ...current };
          delete next[input.selectedNoteId!];
          next[updated.noteId] = updated.content;
          return next;
        });
      } catch (nextError) {
        input.setError(nextError instanceof Error ? nextError.message : "Failed to save note.");
      } finally {
        input.setSaving(false);
      }
    },
    [input],
  );

  const cancelRename = useCallback(() => {
    input.setRenamingNoteId(null);
    if (input.renamingInputRef.current) {
      input.renamingInputRef.current = null;
    }
  }, [input]);

  const hasRenameCommitted = useCallback(() => input.renamingCommittedRef.current, [input]);
  const markRenameCommitted = useCallback(() => {
    input.renamingCommittedRef.current = true;
  }, [input]);

  return {
    cancelRename,
    commitRename,
    getNoteContent,
    handleCreate,
    handleNoteContextMenu,
    handleSave,
    hasRenameCommitted,
    markRenameCommitted,
  };
}
