import { useCallback } from "react";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
} from "~/logic/composer";

import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";

interface UseChatViewComposerActionsInput {
  readonly base: ChatViewBaseState;
  readonly runtime: ChatViewRuntimeState;
  readonly interactions: ChatViewInteractionsState;
}

export function useChatViewComposerActions(input: UseChatViewComposerActionsInput) {
  const setPromptAndCursor = useCallback(
    (nextPrompt: string) => {
      input.base.promptRef.current = nextPrompt;
      input.base.setPrompt(nextPrompt);
      input.base.setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      input.base.setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    },
    [input.base],
  );

  const onMicTranscript = useCallback(
    (text: string) => {
      if (text === input.base.promptRef.current) return;
      setPromptAndCursor(text);
      input.runtime.scheduleComposerFocus();
    },
    [input.base.promptRef, input.runtime, setPromptAndCursor],
  );

  const insertMention = useCallback(
    (mention: string) => {
      const snapshot = input.base.composerEditorRef.current?.readSnapshot();
      const value = snapshot?.value ?? input.base.promptRef.current;
      const expandedCursor =
        snapshot?.expandedCursor ?? expandCollapsedComposerCursor(value, input.base.composerCursor);

      if (input.base.composerDraft.shellMode) {
        input.base.setComposerShellMode(false);
      }

      const prefix = expandedCursor > 0 && !/\s/.test(value[expandedCursor - 1] ?? "") ? " " : "";
      const insertion = prefix + mention;
      const newValue = value.slice(0, expandedCursor) + insertion + value.slice(expandedCursor);
      const newExpandedCursor = expandedCursor + insertion.length;
      const newCursor = collapseExpandedComposerCursor(newValue, newExpandedCursor);

      input.base.promptRef.current = newValue;
      input.base.setPrompt(newValue);
      input.base.setComposerCursor(newCursor);
      input.base.setComposerTrigger(detectComposerTrigger(newValue, newExpandedCursor));
      input.runtime.scheduleComposerFocus();
    },
    [input.base, input.runtime],
  );

  const onOpenReadDialog = useCallback(() => {
    input.base.setReadDocumentDialogOpen(true);
  }, [input.base]);

  const onSubmitReadUrl = useCallback(
    async (url: string) => {
      setPromptAndCursor(`/read ${url}`);
      input.interactions.onSend();
    },
    [input.interactions, setPromptAndCursor],
  );

  const onSubmitReadFiles = useCallback(
    async (files: File[]) => {
      input.interactions.addComposerFiles(files);
      const nextPrompt =
        input.base.promptRef.current.trim().length > 0
          ? input.base.promptRef.current
          : "Read the attached documents and use them as context.";
      setPromptAndCursor(nextPrompt);
      window.requestAnimationFrame(() => {
        input.interactions.onSend();
      });
    },
    [input.base.promptRef, input.interactions, setPromptAndCursor],
  );

  const onUseHandoffFromMeter = useCallback(() => {
    const activeThread = input.base.activeThread;
    if (!activeThread) {
      return;
    }
    void input.interactions.onCreateHandoffBranch(
      activeThread.modelSelection,
      "Continue this work in a fresh branch with the generated handoff.",
    );
  }, [input.base.activeThread, input.interactions]);

  const onCompactFromMeter = useCallback(() => {
    setPromptAndCursor("/compact");
    input.interactions.onSend();
  }, [input.interactions, setPromptAndCursor]);

  return {
    insertMention,
    onCompactFromMeter,
    onMicTranscript,
    onOpenReadDialog,
    onSubmitReadFiles,
    onSubmitReadUrl,
    onUseHandoffFromMeter,
  };
}
