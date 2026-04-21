import { type ProviderInteractionMode, type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { useCallback } from "react";
import {
  type ComposerTrigger,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
} from "../../../logic/composer";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../../logic/user-input";
import { type TerminalContextDraft } from "../../../lib/terminalContext";
import type { ComposerCommandItem } from "../composer/ComposerCommandMenu";
import type { ComposerPromptEditorHandle } from "../composer/ComposerPromptEditor";

export interface UseComposerCommandHandlersInput {
  composerMenuOpenRef: React.MutableRefObject<boolean>;
  composerMenuItemsRef: React.MutableRefObject<ComposerCommandItem[]>;
  activeComposerMenuItemRef: React.MutableRefObject<ComposerCommandItem | null>;
  composerSelectLockRef: React.MutableRefObject<boolean>;
  composerEditorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  promptRef: React.MutableRefObject<string>;
  composerCursor: number;
  composerTerminalContexts: TerminalContextDraft[];
  composerMenuItems: ComposerCommandItem[];
  composerHighlightedItemId: string | null;
  interactionMode: ProviderInteractionMode;
  activePendingProgress: ReturnType<typeof derivePendingUserInputProgress> | null;
  activePendingUserInput: { requestId: string } | null;
  isOpencodePendingUserInputMode: boolean;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  setComposerHighlightedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setComposerDraftTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  threadId: ThreadId;
  setPrompt: (prompt: string) => void;
  setPendingUserInputAnswersByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >;
  applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: { expectedText?: string },
  ) => boolean;
  onProviderModelSelect: (provider: ProviderKind, model: string, subProviderID?: string) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  toggleInteractionMode: () => void;
  onSend: (e?: { preventDefault: () => void }) => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
}

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) return rangeEnd;
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

/** Returns handlers for composer command menu navigation and prompt changes. */
export function useComposerCommandHandlers(input: UseComposerCommandHandlersInput) {
  const {
    composerMenuOpenRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    composerSelectLockRef,
    composerEditorRef,
    promptRef,
    composerCursor,
    composerTerminalContexts,
    composerMenuItems,
    composerHighlightedItemId,
    activePendingProgress,
    activePendingUserInput,
    isOpencodePendingUserInputMode,
    setComposerCursor,
    setComposerTrigger,
    setComposerHighlightedItemId,
    setComposerDraftTerminalContexts,
    threadId,
    setPrompt,
    applyPromptReplacement,
    onProviderModelSelect,
    handleInteractionModeChange,
    toggleInteractionMode,
    onSend,
    onChangeActivePendingUserInputCustomAnswer,
  } = input;

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) return editorSnapshot;
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerEditorRef, composerCursor, composerTerminalContexts, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return { snapshot, trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor) };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `@${item.path} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          {
            expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
          },
        );
        if (applied) setComposerHighlightedItemId(null);
        return;
      }
      if (item.type === "agent") {
        const replacement = `@agent::${item.agent.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          {
            expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
          },
        );
        if (applied) setComposerHighlightedItemId(null);
        return;
      }
      if (item.type === "skill") {
        const replacement = `@skill::${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          {
            expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
          },
        );
        if (applied) setComposerHighlightedItemId(null);
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const replacement = "/model ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) setComposerHighlightedItemId(null);
          return;
        }
        if (item.command === "agents" || item.command === "skills") {
          const replacement = `/${item.command} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            {
              expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
            },
          );
          if (applied) setComposerHighlightedItemId(null);
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) setComposerHighlightedItemId(null);
        return;
      }
      onProviderModelSelect(item.provider, item.model, item.subProviderID);
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) setComposerHighlightedItemId(null);
    },
    [
      applyPromptReplacement,
      composerSelectLockRef,
      handleInteractionModeChange,
      onProviderModelSelect,
      resolveActiveComposerTrigger,
      setComposerHighlightedItemId,
    ],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
    },
    [setComposerHighlightedItemId],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems, setComposerHighlightedItemId],
  );

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (
        activePendingProgress?.activeQuestion &&
        activePendingUserInput &&
        !isOpencodePendingUserInputMode
      ) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      isOpencodePendingUserInputMode,
      composerTerminalContexts,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      threadId,
      promptRef,
      setComposerCursor,
      setComposerTrigger,
    ],
  );

  const onComposerCommandKey = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: KeyboardEvent): boolean => {
      if (key === "Tab" && event.shiftKey) {
        toggleInteractionMode();
        return true;
      }
      const { trigger } = resolveActiveComposerTrigger();
      const menuIsActive = composerMenuOpenRef.current || trigger !== null;
      if (menuIsActive) {
        const currentItems = composerMenuItemsRef.current;
        if (key === "ArrowDown" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowDown");
          return true;
        }
        if (key === "ArrowUp" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowUp");
          return true;
        }
        if (key === "Tab" || key === "Enter") {
          const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
          if (selectedItem) {
            onSelectComposerItem(selectedItem);
            return true;
          }
        }
      }
      if (key === "Enter" && !event.shiftKey) {
        void onSend();
        return true;
      }
      return false;
    },
    [
      activeComposerMenuItemRef,
      composerMenuItemsRef,
      composerMenuOpenRef,
      nudgeComposerMenuHighlight,
      onSelectComposerItem,
      onSend,
      resolveActiveComposerTrigger,
      toggleInteractionMode,
    ],
  );

  return {
    readComposerSnapshot,
    resolveActiveComposerTrigger,
    onSelectComposerItem,
    onComposerMenuItemHighlighted,
    nudgeComposerMenuHighlight,
    onPromptChange,
    onComposerCommandKey,
  };
}
