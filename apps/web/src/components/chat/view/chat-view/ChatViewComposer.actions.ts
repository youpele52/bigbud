import { getRoutableModelSelection } from "../../../../models/provider/selection-helpers.models";
import { useCallback, useLayoutEffect, useRef } from "react";
import { readNativeApi } from "../../../../rpc/nativeApi";
import { MAX_STAGED_DOCUMENT_CHARS } from "../../../../stores/composer/readDocuments.store";
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

  const { addComposerFiles } = input.interactions;
  const latestAddFiles = useRef(addComposerFiles);
  useLayoutEffect(() => {
    latestAddFiles.current = addComposerFiles;
  }, [addComposerFiles]);

  const onSubmitReadUrl = useCallback(async (url: string, signal: AbortSignal) => {
    const api = readNativeApi();
    if (!api) throw new Error("Connect to the server before reading a document URL.");
    const result = await api.server.readDocumentUrl({ url }, { signal });
    if (signal.aborted) return;
    const name =
      (result.title || new URL(result.resolvedUrl).hostname)
        .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
        .slice(0, 96)
        .trim() || "URL document";
    const contents = [
      `Source URL: ${result.sourceUrl}`,
      `Resolved URL: ${result.resolvedUrl.slice(0, 2048)}`,
      ...(result.title ? [`Title: ${result.title.slice(0, 1024)}`] : []),
      "",
      result.text,
    ];
    const readDocumentText = contents.join("\n");
    if (readDocumentText.length > MAX_STAGED_DOCUMENT_CHARS) {
      throw new Error("The extracted document is too large to keep in this draft.");
    }
    const file = new File([readDocumentText], `${name}.txt`, { type: "text/plain" });
    if (!latestAddFiles.current([file], { readDocumentText })) {
      throw new Error("Could not attach this document. Check the attachment limits and try again.");
    }
  }, []);

  const onSubmitReadFiles = useCallback(
    (files: File[]) => addComposerFiles(files, "atomic"),
    [addComposerFiles],
  );

  const onUseHandoffFromMeter = useCallback(() => {
    const activeThread = input.base.activeThread;
    if (!activeThread) {
      return;
    }
    const selection = getRoutableModelSelection(activeThread.modelSelection);
    if (!selection) return;
    void input.interactions.onCreateHandoffBranch(
      selection,
      "Continue this work in a fresh branch with the generated handoff.",
    );
  }, [input.base.activeThread, input.interactions]);

  return {
    insertMention,
    onMicTranscript,
    onOpenReadDialog,
    onSubmitReadFiles,
    onSubmitReadUrl,
    onUseHandoffFromMeter,
  };
}
