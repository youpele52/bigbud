import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { $getRoot, type EditorState } from "lexical";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type Ref,
} from "react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "../../../logic/composer";
import { cn } from "~/lib/utils";
import {
  $readExpandedSelectionOffsetFromEditorState,
  $readSelectionOffsetFromEditorState,
  $setComposerEditorPrompt,
  $setSelectionAtComposerOffset,
  clampExpandedCursor,
  collectTerminalContextIds,
  terminalContextSignature,
} from "./ComposerPromptEditor.nodes.helpers";
import {
  ComposerTerminalContextActionsContext,
  ComposerCommandKeyPlugin,
  ComposerInlineTokenArrowPlugin,
  ComposerInlineTokenSelectionNormalizePlugin,
  ComposerInlineTokenBackspacePlugin,
} from "./ComposerPromptEditor.plugins";
import { ComposerSurroundSelectionPlugin } from "./ComposerPromptEditor.surroundSelection";
import {
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditor.shared";

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
}

export function ComposerPromptEditorInner({
  value,
  cursor,
  terminalContexts,
  discoveredSkills = [],
  disabled,
  placeholder,
  className,
  onRemoveTerminalContext,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const terminalContextsSignature = terminalContextSignature(terminalContexts);
  const discoveredSkillsSignature = useMemo(
    () => discoveredSkills.map((skill) => `${skill.id}:${skill.name}:${skill.source}`).join("|"),
    [discoveredSkills],
  );
  const terminalContextsSignatureRef = useRef(terminalContextsSignature);
  const discoveredSkillsSignatureRef = useRef(discoveredSkillsSignature);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
    terminalContextIds: terminalContexts.map((context) => context.id),
  });
  const isApplyingControlledUpdateRef = useRef(false);
  const terminalContextActions = useMemo(
    () => ({ onRemoveTerminalContext }),
    [onRemoveTerminalContext],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    const contextsChanged = terminalContextsSignatureRef.current !== terminalContextsSignature;
    const discoveredSkillsChanged =
      discoveredSkillsSignatureRef.current !== discoveredSkillsSignature;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      !contextsChanged &&
      !discoveredSkillsChanged
    ) {
      return;
    }

    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor),
      terminalContextIds: terminalContexts.map((context) => context.id),
    };
    terminalContextsSignatureRef.current = terminalContextsSignature;
    discoveredSkillsSignatureRef.current = discoveredSkillsSignature;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (
      previousSnapshot.value === value &&
      !contextsChanged &&
      !discoveredSkillsChanged &&
      !isFocused
    ) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    editor.update(() => {
      const shouldRewriteEditorState =
        previousSnapshot.value !== value || contextsChanged || discoveredSkillsChanged;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value, terminalContexts, discoveredSkills);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(normalizedCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [
    cursor,
    discoveredSkills,
    discoveredSkillsSignature,
    editor,
    terminalContexts,
    terminalContextsSignature,
    value,
  ]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        terminalContextIds: snapshotRef.current.terminalContextIds,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.terminalContextIds,
      );
    },
    [editor],
  );

  const readSnapshot = useCallback(() => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
            snapshotRef.current.value,
            snapshotRef.current.value.length,
          ),
        );
      },
      readSnapshot,
    }),
    [focusAt, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor &&
        previousSnapshot.terminalContextIds.length === terminalContextIds.length &&
        previousSnapshot.terminalContextIds.every((id, index) => id === terminalContextIds[index])
      ) {
        return;
      }
      if (isApplyingControlledUpdateRef.current) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextExpandedCursor,
        cursorAdjacentToMention,
        terminalContextIds,
      );
    });
  }, []);

  return (
    <ComposerTerminalContextActionsContext.Provider value={terminalContextActions}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "block max-h-[200px] min-h-17.5 w-full touch-pan-y overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-sm leading-relaxed text-foreground focus:outline-none sm:text-[13px]",
                className,
              )}
              data-testid="composer-editor"
              aria-placeholder={placeholder}
              placeholder={<span />}
              onPaste={onPaste}
            />
          }
          placeholder={
            terminalContexts.length > 0 ? null : (
              <div className="pointer-events-none absolute inset-0 text-sm leading-relaxed text-muted-foreground/35 sm:text-[13px]">
                {placeholder}
              </div>
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
        <ComposerSurroundSelectionPlugin terminalContexts={terminalContexts} />
        <ComposerInlineTokenArrowPlugin />
        <ComposerInlineTokenSelectionNormalizePlugin />
        <ComposerInlineTokenBackspacePlugin />
        <HistoryPlugin />
      </div>
    </ComposerTerminalContextActionsContext.Provider>
  );
}
