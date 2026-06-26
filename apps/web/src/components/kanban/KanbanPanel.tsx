import {
  type KanbanCard,
  type KanbanCardId,
  type KanbanCardSummary,
  type KanbanStatus,
  type ThreadId,
} from "@bigbud/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { ensureNativeApi } from "~/rpc/nativeApi";
import { useKanbanPanelStore } from "~/stores/kanban/kanbanPanel.store";
import { useProjectById, useThreadById } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";
import { KanbanBoard } from "./KanbanBoard";
import { KanbanEditorOverlay } from "./KanbanEditorOverlay";
import { applyKanbanBoardChange } from "./kanban.logic";
import { duplicateKanbanCard, persistKanbanBoardChange } from "./KanbanPanel.actions";
import { runKanbanCardContextMenu } from "./KanbanPanel.contextMenu";
import { mergeEditingCardIntoBoard, refreshKanbanCardsList } from "./KanbanPanel.live";

interface KanbanPanelProps {
  activeThreadId?: ThreadId | null;
}

interface EditorState {
  mode: "create" | "edit";
  cardId: KanbanCardId | null;
}

const EMPTY_CARD_TITLE = "Untitled";
const EMPTY_CARD_CONTENT = "";

export const KanbanPanelContent = memo(function KanbanPanelContent({
  activeThreadId,
}: KanbanPanelProps) {
  const scope = useKanbanPanelStore((state) => state.scope);
  const setScope = useKanbanPanelStore((state) => state.setScope);
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const { copyToClipboard } = useCopyToClipboard();
  const cwd = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? undefined;

  const [cards, setCards] = useState<ReadonlyArray<KanbanCardSummary>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [editorStatus, setEditorStatus] = useState<KanbanStatus>("todo");
  const [savedTitle, setSavedTitle] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [savedStatus, setSavedStatus] = useState<KanbanStatus>("todo");
  const [editingCard, setEditingCard] = useState<KanbanCard | null>(null);

  const editingCardRef = useRef<KanbanCard | null>(editingCard);
  editingCardRef.current = editingCard;
  const cardsRef = useRef<ReadonlyArray<KanbanCardSummary>>(cards);
  cardsRef.current = cards;
  const editorStateRef = useRef<EditorState | null>(editorState);
  editorStateRef.current = editorState;
  const editorTitleRef = useRef(editorTitle);
  editorTitleRef.current = editorTitle;
  const editorContentRef = useRef(editorContent);
  editorContentRef.current = editorContent;
  const editorStatusRef = useRef(editorStatus);
  editorStatusRef.current = editorStatus;
  const savedTitleRef = useRef(savedTitle);
  savedTitleRef.current = savedTitle;
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;
  const savedStatusRef = useRef(savedStatus);
  savedStatusRef.current = savedStatus;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  const projectId = project?.id ?? null;
  const resolvedScope = projectId ? scope : "global";
  const scopedProjectId = resolvedScope === "project" ? projectId : null;

  const loadCards = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ensureNativeApi().kanban.list({ projectId, scope: resolvedScope });
      setCards(result.cards);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load kanban tasks.");
    } finally {
      setLoading(false);
    }
  }, [projectId, resolvedScope]);

  const refreshCardsList = useCallback(async () => {
    try {
      const currentEditorState = editorStateRef.current;
      const editingCardId = currentEditorState?.mode === "edit" ? currentEditorState.cardId : null;
      const refreshResult = await refreshKanbanCardsList({
        projectId,
        resolvedScope,
        editingCardId,
        currentCards: cardsRef.current,
        editor: {
          title: editorTitleRef.current,
          content: editorContentRef.current,
          status: editorStatusRef.current,
        },
        saved: {
          title: savedTitleRef.current,
          content: savedContentRef.current,
          status: savedStatusRef.current,
        },
        isSaving: savingRef.current,
      });

      setCards(refreshResult.cards);
      if (refreshResult.type !== "sync") {
        return;
      }

      const card = refreshResult.card;
      setEditingCard(card);
      setEditorTitle(card.title);
      setEditorContent(card.content);
      setEditorStatus(card.status);
      setSavedTitle(card.title);
      setSavedContent(card.content);
      setSavedStatus(card.status);
    } catch {
      // Ignore background refresh failures.
    }
  }, [projectId, resolvedScope]);

  useEffect(() => {
    void loadCards();
    const intervalId = window.setInterval(() => {
      void refreshCardsList();
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [loadCards, refreshCardsList]);

  const openCreateEditor = useCallback((status: KanbanStatus) => {
    setError(null);
    setEditorState({ mode: "create", cardId: null });
    setEditingCard(null);
    setEditorTitle(EMPTY_CARD_TITLE);
    setEditorContent(EMPTY_CARD_CONTENT);
    setEditorStatus(status);
    setSavedTitle(EMPTY_CARD_TITLE);
    setSavedContent(EMPTY_CARD_CONTENT);
    setSavedStatus(status);
  }, []);

  const openEditEditor = useCallback(async (cardId: KanbanCardId) => {
    setError(null);
    try {
      const card = await ensureNativeApi().kanban.get({ cardId });
      setEditingCard(card);
      setEditorState({ mode: "edit", cardId });
      setEditorTitle(card.title);
      setEditorContent(card.content);
      setEditorStatus(card.status);
      setSavedTitle(card.title);
      setSavedContent(card.content);
      setSavedStatus(card.status);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load kanban task.");
    }
  }, []);

  const closeEditor = useCallback(() => {
    setEditorState(null);
    setEditingCard(null);
    setEditorTitle("");
    setEditorContent("");
    setEditorStatus("todo");
    setSavedTitle("");
    setSavedContent("");
    setSavedStatus("todo");
  }, []);

  const handleBoardChange = useCallback(
    async (change: { cardId: KanbanCardId; status: KanbanStatus; targetIndex: number }) => {
      const previousCards = cardsRef.current;
      setCards(applyKanbanBoardChange(previousCards, change));
      setError(null);

      try {
        const { moved } = await persistKanbanBoardChange({
          previousCards,
          change,
          editingCard: editingCardRef.current,
        });

        if (editingCardRef.current?.cardId === moved.cardId) {
          setEditingCard(moved);
          setEditorStatus(moved.status);
          setSavedStatus(moved.status);
        }

        await refreshCardsList();
      } catch (nextError) {
        setCards(previousCards);
        setError(
          nextError instanceof Error ? nextError.message : "Failed to update kanban task position.",
        );
      }
    },
    [refreshCardsList],
  );

  const handleDuplicateCard = useCallback(
    async (card: KanbanCardSummary) => {
      setError(null);
      try {
        await duplicateKanbanCard(card);
        await loadCards();
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : "Failed to duplicate kanban task.",
        );
      }
    },
    [loadCards],
  );

  const handleDeleteCard = useCallback(
    async (cardId: KanbanCardId) => {
      setSaving(true);
      setError(null);
      try {
        await ensureNativeApi().kanban.delete({ cardId });
        closeEditor();
        await loadCards();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to delete kanban task.");
      } finally {
        setSaving(false);
      }
    },
    [closeEditor, loadCards],
  );

  const handleSaveEditor = useCallback(async () => {
    if (!editorState) return;

    const trimmedTitle = editorTitle.trim();
    if (trimmedTitle.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      if (editorState.mode === "create") {
        await ensureNativeApi().kanban.create({
          projectId: scopedProjectId,
          title: trimmedTitle,
          content: editorContent,
          status: editorStatus,
        });
      } else if (editingCardRef.current) {
        const updated = await ensureNativeApi().kanban.update({
          cardId: editingCardRef.current.cardId,
          title: trimmedTitle,
          content: editorContent,
          expectedUpdatedAt: editingCardRef.current.updatedAt,
        });
        const moved =
          updated.status !== editorStatus
            ? await ensureNativeApi().kanban.move({
                cardId: updated.cardId,
                status: editorStatus,
              })
            : updated;
        setEditingCard(moved);
        setSavedTitle(trimmedTitle);
        setSavedContent(editorContent);
        setSavedStatus(moved.status);
      }

      await loadCards();
      closeEditor();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save kanban task.");
    } finally {
      setSaving(false);
    }
  }, [
    closeEditor,
    editorContent,
    editorState,
    editorStatus,
    editorTitle,
    loadCards,
    scopedProjectId,
  ]);

  const handleCardContextMenu = useCallback(
    async (card: KanbanCardSummary, position: { x: number; y: number }) => {
      await runKanbanCardContextMenu({
        card,
        cards: cardsRef.current,
        position,
        onBoardChange: handleBoardChange,
        onCopyPath: (path) => copyToClipboard(path, undefined),
        onDelete: handleDeleteCard,
        onDuplicate: handleDuplicateCard,
        onEdit: openEditEditor,
      });
    },
    [copyToClipboard, handleBoardChange, handleDeleteCard, handleDuplicateCard, openEditEditor],
  );

  const editingCardId = useMemo(
    () => (editorState?.mode === "edit" ? editorState.cardId : null),
    [editorState],
  );
  const boardCards = useMemo(
    () => mergeEditingCardIntoBoard(cards, editingCardId, editorTitle, editorStatus),
    [cards, editorStatus, editorTitle, editingCardId],
  );
  const editorDeleteCardId =
    editorState?.mode === "edit" && editorState.cardId !== null ? editorState.cardId : null;
  const editorDeleteHandler =
    editorDeleteCardId !== null ? () => handleDeleteCard(editorDeleteCardId) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border p-2">
        <ToggleGroup
          aria-label="Switch kanban scope"
          variant="toolbar"
          size="xs"
          value={[resolvedScope]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "project" || next === "global") {
              setScope(next);
            }
          }}
        >
          <Toggle aria-label="Global board" value="global">
            Global
          </Toggle>
          <Toggle aria-label="Project board" disabled={!projectId} value="project">
            Project
          </Toggle>
        </ToggleGroup>
      </div>
      {error ? (
        <div className="border-b border-border px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}
      {loading && cards.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">Loading kanban board...</div>
      ) : (
        <KanbanBoard
          cards={boardCards}
          editingCardId={editingCardId}
          onCardContextMenu={handleCardContextMenu}
          onBoardChange={handleBoardChange}
          onCreateCard={openCreateEditor}
          onSelectCard={(cardId) => void openEditEditor(cardId)}
        />
      )}
      {editorState ? (
        <div className="absolute inset-0 z-20">
          <KanbanEditorOverlay
            content={editorContent}
            cwd={cwd}
            error={error}
            mode={editorState.mode}
            saving={saving}
            selectedStatus={editorStatus}
            title={editorTitle}
            onCancel={closeEditor}
            onContentChange={setEditorContent}
            onDelete={editorDeleteHandler}
            onSave={handleSaveEditor}
            onStatusChange={setEditorStatus}
            onTitleChange={setEditorTitle}
          />
        </div>
      ) : null}
    </div>
  );
});
