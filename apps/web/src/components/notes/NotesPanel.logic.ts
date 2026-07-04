import { NoteId, type ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useDirectoryChangeRefresh } from "~/hooks/useDirectoryChangeRefresh";
import { getNotesWatchRoots } from "~/hooks/storageRoots";
import { basenameOfPath } from "~/lib/vscode-icons";
import { ensureNativeApi } from "~/rpc/nativeApi";
import { useDefaultChatCwd, useServerConfig } from "~/rpc/serverState";
import { useProjectById, useThreadById } from "~/stores/main";
import type { AnnotationIntent } from "~/stores/composer";
import { useComposerDraftStore } from "~/stores/composer";
import { useNotesPanelStore } from "~/stores/notes/notesPanel.store";
import { useUiStateStore } from "~/stores/ui";

import { makeAnnotationId } from "../files/FilesPanel.shared";
import { useNotesPanelActions } from "./NotesPanel.actions";
import { type NotesListItem } from "./NotesPanel.list";

function deriveWorkspaceRoot(
  worktreePath: string | null | undefined,
  projectCwd: string | null | undefined,
  defaultChatCwd: string | null | undefined,
): string | null {
  return worktreePath ?? projectCwd ?? defaultChatCwd ?? null;
}

interface UseNotesPanelStateInput {
  readonly activeThreadId?: ThreadId | null;
}

export function useNotesPanelState(input: UseNotesPanelStateInput) {
  const scope = useNotesPanelStore((state) => state.scope);
  const selectedNoteId = useNotesPanelStore((state) => state.selectedNoteId);
  const previewMode = useNotesPanelStore((state) => state.previewMode);
  const setScope = useNotesPanelStore((state) => state.setScope);
  const setSelectedNoteId = useNotesPanelStore((state) => state.setSelectedNoteId);
  const setPreviewMode = useNotesPanelStore((state) => state.setPreviewMode);
  const thread = useThreadById(input.activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const serverConfig = useServerConfig();
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const { copyToClipboard } = useCopyToClipboard();
  const workspaceRoot = deriveWorkspaceRoot(thread?.worktreePath, project?.cwd, defaultChatCwd);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const [notes, setNotes] = useState<ReadonlyArray<NotesListItem>>([]);
  const [selectedContent, setSelectedContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [noteContentsById, setNoteContentsById] = useState<Record<NoteId, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<NoteId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [annotationRange, setAnnotationRange] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const notesRef = useRef<ReadonlyArray<NotesListItem>>(notes);
  const selectedNoteIdRef = useRef<NoteId | null>(selectedNoteId);
  const selectedContentRef = useRef(selectedContent);
  const savedContentRef = useRef(savedContent);
  notesRef.current = notes;
  selectedNoteIdRef.current = selectedNoteId;
  selectedContentRef.current = selectedContent;
  savedContentRef.current = savedContent;

  const projectId = project?.id ?? null;
  const resolvedScope = projectId ? scope : "global";

  const loadNotes = useCallback(
    async (nextSelectedNoteId?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const api = ensureNativeApi();
        const result = await api.notes.list({
          projectId,
          scope: resolvedScope,
        });
        setNotes(result.notes);
        const resolvedSelectedNoteId = nextSelectedNoteId ?? selectedNoteId;
        const nextSelected =
          result.notes.find((note) => note.noteId === resolvedSelectedNoteId)?.noteId ?? null;
        setSelectedNoteId(nextSelected);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load notes.");
      } finally {
        setLoading(false);
      }
    },
    [projectId, resolvedScope, selectedNoteId, setSelectedNoteId],
  );

  const refreshNotesList = useCallback(async () => {
    try {
      const api = ensureNativeApi();
      const result = await api.notes.list({ projectId, scope: resolvedScope });

      const currentNotes = notesRef.current;
      const currentSelectedId = selectedNoteIdRef.current;
      const currentSelectedNote = currentNotes.find((note) => note.noteId === currentSelectedId);
      const refreshedSelectedNote = result.notes.find((note) => note.noteId === currentSelectedId);

      setNotes(result.notes);

      if (
        refreshedSelectedNote &&
        currentSelectedNote &&
        refreshedSelectedNote.updatedAt !== currentSelectedNote.updatedAt &&
        selectedContentRef.current === savedContentRef.current
      ) {
        const note = await api.notes.get({ noteId: currentSelectedId! });
        setSelectedContent(note.content);
        setSavedContent(note.content);
        setNoteContentsById((current) => ({
          ...current,
          [note.noteId]: note.content,
        }));
      } else if (currentSelectedId && !refreshedSelectedNote && currentSelectedNote) {
        const sameProjectNotes = result.notes.filter(
          (note) => note.projectId === currentSelectedNote.projectId,
        );
        if (sameProjectNotes.length > 0) {
          const mostRecent = sameProjectNotes.reduce((a, b) =>
            new Date(b.updatedAt).getTime() > new Date(a.updatedAt).getTime() ? b : a,
          );
          setSelectedNoteId(mostRecent.noteId);
          if (selectedContentRef.current === savedContentRef.current) {
            const note = await api.notes.get({ noteId: mostRecent.noteId });
            setSelectedContent(note.content);
            setSavedContent(note.content);
            setNoteContentsById((current) => {
              const next = { ...current };
              delete next[currentSelectedId];
              next[note.noteId] = note.content;
              return next;
            });
          }
        } else {
          setSelectedNoteId(null);
        }
      }
    } catch {
      // Silently ignore refresh failures.
    }
  }, [projectId, resolvedScope, setSelectedNoteId]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  useDirectoryChangeRefresh({
    watchRoots: getNotesWatchRoots(serverConfig?.storage, projectId, resolvedScope),
    refresh: () => {
      void refreshNotesList();
    },
  });

  useEffect(() => {
    if (!selectedNoteId) {
      setSelectedContent("");
      setSavedContent("");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const note = await ensureNativeApi().notes.get({ noteId: selectedNoteId });
        if (!cancelled) {
          setSelectedContent(note.content);
          setSavedContent(note.content);
          setNoteContentsById((current) => ({
            ...current,
            [note.noteId]: note.content,
          }));
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load note.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedNoteId]);

  const selectedNote = useMemo(
    () => notes.find((note) => note.noteId === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  const annotationText = useMemo(() => {
    if (!annotationRange) return "";
    return selectedContent
      .split("\n")
      .slice(annotationRange.startLine - 1, annotationRange.endLine)
      .join("\n");
  }, [annotationRange, selectedContent]);

  const handleAnnotateSelection = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      if (!input.activeThreadId || !selectedNote) return;

      let selectedText = "";
      if (!previewMode && editorRef.current) {
        const { selectionStart, selectionEnd, value } = editorRef.current;
        if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
          selectedText = value.slice(selectionStart, selectionEnd).trim();
        }
      } else {
        selectedText = window.getSelection()?.toString().trim() ?? "";
      }

      if (selectedText.length < 2) return;

      event.preventDefault();
      event.stopPropagation();

      const clicked = await ensureNativeApi().contextMenu.show(
        [{ id: "annotate-selection", label: "Annotate selection" }],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked !== "annotate-selection") return;

      const startIndex = selectedContent.indexOf(selectedText);
      if (startIndex === -1) {
        setAnnotationRange({ startLine: 1, endLine: 1 });
        return;
      }

      const endIndex = startIndex + selectedText.length;
      setAnnotationRange({
        startLine: selectedContent.slice(0, startIndex).split("\n").length,
        endLine: selectedContent.slice(0, endIndex).split("\n").length,
      });
    },
    [input.activeThreadId, previewMode, selectedContent, selectedNote],
  );

  const handleCreateAnnotation = useCallback(
    (annotation: { intent: AnnotationIntent; comment: string }) => {
      if (!input.activeThreadId || !selectedNote || !annotationRange) return;

      const absolutePath = selectedNote.absolutePath;
      const lastSlashIndex = absolutePath.lastIndexOf("/");
      const noteCwd = lastSlashIndex === -1 ? "" : absolutePath.slice(0, lastSlashIndex);
      addAnnotation(input.activeThreadId, {
        id: makeAnnotationId(),
        kind: "code",
        comment: annotation.comment,
        intent: annotation.intent,
        createdAt: new Date().toISOString(),
        file: {
          ...(project?.name ? { projectName: project.name } : {}),
          cwd: noteCwd,
          relativePath: basenameOfPath(absolutePath),
        },
        selection: {
          startLine: annotationRange.startLine,
          endLine: annotationRange.endLine,
          text: annotationText,
        },
      });
      setAnnotationRange(null);
    },
    [
      addAnnotation,
      annotationRange,
      annotationText,
      input.activeThreadId,
      project?.name,
      selectedNote,
    ],
  );

  const onRenamingInputMount = useCallback((element: HTMLInputElement | null) => {
    if (element && renamingInputRef.current !== element) {
      renamingInputRef.current = element;
      element.focus();
      element.select();
      return;
    }
    if (element === null && renamingInputRef.current !== null) {
      renamingInputRef.current = null;
    }
  }, []);

  const {
    cancelRename,
    commitRename,
    handleCreate,
    handleNoteContextMenu,
    handleSave,
    hasRenameCommitted,
    markRenameCommitted,
  } = useNotesPanelActions({
    copyToClipboard,
    getNoteContentFromCache: (noteId) => noteContentsById[noteId],
    loadNotes,
    projectId,
    renamingCommittedRef,
    renamingInputRef,
    resolvedScope,
    selectedNote,
    selectedNoteId,
    setError,
    setNoteContentsById,
    setNotes,
    setPreviewMode,
    setRenamingNoteId,
    setRenamingTitle,
    setSavedContent,
    setSaving,
    setSelectedNoteId,
  });

  useEffect(() => {
    if (!selectedNoteId || previewMode || selectedContent === savedContent) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void handleSave(selectedContent);
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [handleSave, previewMode, savedContent, selectedContent, selectedNoteId]);

  return {
    annotationRange,
    annotationText,
    cancelRename,
    commitRename,
    cwd: workspaceRoot ?? undefined,
    editorRef,
    error,
    handleAnnotateSelection,
    handleCreate,
    handleCreateAnnotation,
    handleNoteContextMenu,
    hasRenameCommitted,
    loading,
    markRenameCommitted,
    notes,
    onRenamingInputMount,
    previewMode,
    projectId,
    renamingNoteId,
    renamingTitle,
    resolvedScope,
    saving,
    selectedContent,
    selectedNote,
    selectedNoteId,
    setAnnotationRange,
    setPreviewMode,
    setRenamingTitle,
    setScope,
    setSelectedContent,
    setSelectedNoteId,
  };
}
