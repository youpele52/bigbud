import { NoteId, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BaseMarkdown } from "~/components/common/BaseMarkdown";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "~/components/annotations/AnnotationComposerPanel";
import { useComposerDraftStore } from "~/stores/composer";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { ensureNativeApi } from "~/rpc/nativeApi";
import { useProjectById, useThreadById } from "~/stores/main";
import { useNotesPanelStore } from "~/stores/notes/notesPanel.store";
import { useUiStateStore } from "~/stores/ui";
import { basenameOfPath } from "~/lib/vscode-icons";
import { openPathInPreferredApp } from "~/models/editor";
import { makeAnnotationId } from "../files/FilesPanel.shared";
import { NotesPanelList, type NotesListItem } from "./NotesPanel.list";
import type { AnnotationIntent } from "../../stores/composer";

function deriveWorkspaceRoot(
  worktreePath: string | null | undefined,
  projectCwd: string | null | undefined,
  defaultChatCwd: string | null | undefined,
): string | null {
  return worktreePath ?? projectCwd ?? defaultChatCwd ?? null;
}

interface NotesPanelProps {
  activeThreadId?: ThreadId | null;
}

export const NotesPanelContent = memo(function NotesPanelContent({
  activeThreadId,
}: NotesPanelProps) {
  const scope = useNotesPanelStore((state) => state.scope);
  const selectedNoteId = useNotesPanelStore((state) => state.selectedNoteId);
  const previewMode = useNotesPanelStore((state) => state.previewMode);
  const setScope = useNotesPanelStore((state) => state.setScope);
  const setSelectedNoteId = useNotesPanelStore((state) => state.setSelectedNoteId);
  const setPreviewMode = useNotesPanelStore((state) => state.setPreviewMode);
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const { copyToClipboard } = useCopyToClipboard();
  const workspaceRoot = deriveWorkspaceRoot(thread?.worktreePath, project?.cwd, defaultChatCwd);
  const cwd = workspaceRoot ?? undefined;
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
  const selectedContentRef = useRef<string>(selectedContent);
  const savedContentRef = useRef<string>(savedContent);
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
        // Same noteId: content was updated, noteId unchanged
        const note = await api.notes.get({ noteId: currentSelectedId! });
        setSelectedContent(note.content);
        setSavedContent(note.content);
        setNoteContentsById((current) => ({
          ...current,
          [note.noteId]: note.content,
        }));
      } else if (currentSelectedId && !refreshedSelectedNote && currentSelectedNote) {
        // Old noteId gone: note was likely renamed by the agent.
        // Follow it by picking the most-recently-updated note with the same projectId.
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
      // Silently ignore refresh failures
    }
  }, [projectId, resolvedScope, setSelectedNoteId]);

  useEffect(() => {
    void loadNotes();
    const intervalId = window.setInterval(() => {
      void refreshNotesList();
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [loadNotes, refreshNotesList]);

  useEffect(() => {
    if (!selectedNoteId) {
      setSelectedContent("");
      setSavedContent("");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const api = ensureNativeApi();
        const note = await api.notes.get({
          noteId: selectedNoteId,
        });
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

  const handleAnnotateSelection = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      if (!activeThreadId || !selectedNote) return;

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

      let startLine: number;
      let endLine: number;
      const startIndex = selectedContent.indexOf(selectedText);
      if (startIndex !== -1) {
        const endIndex = startIndex + selectedText.length;
        startLine = selectedContent.slice(0, startIndex).split("\n").length;
        endLine = selectedContent.slice(0, endIndex).split("\n").length;
      } else {
        startLine = 1;
        endLine = 1;
      }

      setAnnotationRange({ startLine, endLine });
    },
    [activeThreadId, previewMode, selectedContent, selectedNote],
  );

  const annotationText = useMemo(() => {
    if (!annotationRange) return "";
    return selectedContent
      .split("\n")
      .slice(annotationRange.startLine - 1, annotationRange.endLine)
      .join("\n");
  }, [annotationRange, selectedContent]);

  const handleCreateAnnotation = useCallback(
    (input: { intent: AnnotationIntent; comment: string }) => {
      if (!activeThreadId || !selectedNote || !annotationRange) return;

      const absolutePath = selectedNote.absolutePath;
      const lastSlashIndex = absolutePath.lastIndexOf("/");
      const noteCwd = lastSlashIndex === -1 ? "" : absolutePath.slice(0, lastSlashIndex);
      const noteBasename = basenameOfPath(absolutePath);

      addAnnotation(activeThreadId, {
        id: makeAnnotationId(),
        kind: "code",
        comment: input.comment,
        intent: input.intent,
        createdAt: new Date().toISOString(),
        file: {
          ...(project?.name ? { projectName: project.name } : {}),
          cwd: noteCwd,
          relativePath: noteBasename,
        },
        selection: {
          startLine: annotationRange.startLine,
          endLine: annotationRange.endLine,
          text: annotationText,
        },
      });
      setAnnotationRange(null);
    },
    [activeThreadId, addAnnotation, annotationRange, annotationText, project?.name, selectedNote],
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

  const cancelRename = useCallback(() => {
    setRenamingNoteId(null);
    renamingInputRef.current = null;
  }, []);

  const hasRenameCommitted = useCallback(() => renamingCommittedRef.current, []);

  const markRenameCommitted = useCallback(() => {
    renamingCommittedRef.current = true;
  }, []);

  const handleCreate = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const created = await api.notes.create({
        projectId: resolvedScope === "project" ? projectId : null,
        title: "Untitled note",
        content: "# Untitled note\n",
      });
      setNoteContentsById((current) => ({
        ...current,
        [created.noteId]: created.content,
      }));
      await loadNotes(created.noteId);
      setPreviewMode(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create note.");
    } finally {
      setSaving(false);
    }
  }, [loadNotes, projectId, resolvedScope, setPreviewMode]);

  const deleteNote = useCallback(
    async (noteId: NoteId, title: string) => {
      const api = ensureNativeApi();
      const confirmed = await api.dialogs.confirm(`Delete note "${title}"?`);
      if (!confirmed) return;

      setSaving(true);
      setError(null);
      try {
        await api.notes.delete({ noteId });
        setNoteContentsById((current) => {
          const next = { ...current };
          delete next[noteId];
          return next;
        });
        await loadNotes(selectedNoteId === noteId ? undefined : selectedNoteId);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to delete note.");
      } finally {
        setSaving(false);
      }
    },
    [loadNotes, selectedNoteId],
  );

  const getNoteContent = useCallback(
    async (noteId: NoteId) => {
      const existingContent = noteContentsById[noteId];
      if (existingContent !== undefined) {
        return existingContent;
      }
      const note = await ensureNativeApi().notes.get({
        noteId,
      });
      setNoteContentsById((current) => ({
        ...current,
        [note.noteId]: note.content,
      }));
      return note.content;
    },
    [noteContentsById],
  );

  const commitRename = useCallback(
    async (noteId: NoteId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingNoteId((current) => {
          if (current !== noteId) return current;
          renamingInputRef.current = null;
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
        if (selectedNoteId === noteId && updated.noteId !== noteId) {
          setSelectedNoteId(updated.noteId);
        }
        setNotes((current) =>
          current.map((note) =>
            note.noteId === noteId
              ? {
                  noteId: updated.noteId,
                  projectId: updated.projectId,
                  title: updated.title,
                  absolutePath: updated.absolutePath,
                  createdAt: updated.createdAt,
                  updatedAt: updated.updatedAt,
                }
              : note,
          ),
        );
        setNoteContentsById((current) => {
          const next = { ...current };
          delete next[noteId];
          next[updated.noteId] = updated.content;
          return next;
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to rename note.");
      }

      finishRename();
    },
    [getNoteContent, selectedNoteId, setSelectedNoteId],
  );

  const handleDuplicate = useCallback(
    async (note: NotesListItem) => {
      try {
        const created = await ensureNativeApi().notes.create({
          projectId: note.projectId as ProjectId | null,
          title: `Copy of ${note.title}`,
          content: await getNoteContent(note.noteId),
        });
        setNoteContentsById((current) => ({
          ...current,
          [created.noteId]: created.content,
        }));
        await loadNotes(created.noteId);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to duplicate note.");
      }
    },
    [getNoteContent, loadNotes],
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
        setSelectedNoteId(note.noteId);
        setRenamingNoteId(note.noteId);
        setRenamingTitle(note.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "copy") {
        copyToClipboard(await getNoteContent(note.noteId));
        return;
      }

      if (clicked === "copy-path") {
        copyToClipboard(note.absolutePath);
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
    [copyToClipboard, deleteNote, getNoteContent, handleDuplicate, setSelectedNoteId],
  );

  const handleSave = useCallback(
    async (nextContent: string) => {
      if (!selectedNoteId) return;
      setSaving(true);
      setError(null);
      try {
        const api = ensureNativeApi();
        const updated = await api.notes.update({
          noteId: selectedNoteId,
          content: nextContent,
          ...(selectedNote ? { expectedUpdatedAt: selectedNote.updatedAt } : {}),
        });
        if (updated.noteId !== selectedNoteId) {
          setSelectedNoteId(updated.noteId);
        }
        setNotes((current) =>
          current.map((note) =>
            note.noteId === selectedNoteId
              ? {
                  noteId: updated.noteId,
                  projectId: updated.projectId,
                  title: updated.title,
                  absolutePath: updated.absolutePath,
                  createdAt: updated.createdAt,
                  updatedAt: updated.updatedAt,
                }
              : note,
          ),
        );
        setSavedContent(updated.content);
        setNoteContentsById((current) => {
          const next = { ...current };
          delete next[selectedNoteId];
          next[updated.noteId] = updated.content;
          return next;
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to save note.");
      } finally {
        setSaving(false);
      }
    },
    [selectedNote, selectedNoteId, setSelectedNoteId],
  );

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

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {selectedNoteId ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-border p-2">
            <div className="truncate text-sm font-medium">{selectedNote?.title ?? "Notes"}</div>
            <div className="flex items-center gap-2">
              <ToggleGroup
                aria-label="Switch note editor view"
                variant="toolbar"
                size="xs"
                value={[previewMode ? "preview" : "edit"]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "edit") {
                    setPreviewMode(false);
                  }
                  if (next === "preview") {
                    setPreviewMode(true);
                  }
                }}
              >
                <Toggle aria-label="Edit note" value="edit">
                  Edit
                </Toggle>
                <Toggle aria-label="Preview note" value="preview">
                  Preview
                </Toggle>
              </ToggleGroup>
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto p-3"
            onContextMenu={(event) => void handleAnnotateSelection(event)}
          >
            {previewMode ? (
              <BaseMarkdown
                text={selectedContent}
                cwd={cwd}
                isStreaming={false}
                preserveLineBreaks
                className="note-markdown"
              />
            ) : (
              <Textarea
                ref={editorRef}
                value={selectedContent}
                onChange={(event) => setSelectedContent(event.target.value)}
                className="h-full min-h-full !bg-background"
                unstyled={false}
              />
            )}
            {annotationRange && activeThreadId ? (
              <div className="sticky bottom-3 mx-auto mt-3">
                <AnnotationComposerPanel
                  targetLabel={formatAnnotationTargetLabel(annotationRange)}
                  onCancel={() => setAnnotationRange(null)}
                  onSubmit={handleCreateAnnotation}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <NotesPanelList
        loading={loading}
        error={error}
        saving={saving}
        notes={notes}
        selectedNoteId={selectedNoteId}
        projectId={projectId}
        resolvedScope={resolvedScope}
        renamingNoteId={renamingNoteId}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        onRenamingInputMount={onRenamingInputMount}
        hasRenameCommitted={hasRenameCommitted}
        markRenameCommitted={markRenameCommitted}
        setScope={setScope}
        onCreate={handleCreate}
        onSelectNote={setSelectedNoteId}
        onContextMenu={handleNoteContextMenu}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
      />
    </div>
  );
});
