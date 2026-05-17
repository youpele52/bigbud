import { type ThreadId } from "@bigbud/contracts";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";

import { detectComposerTrigger, expandCollapsedComposerCursor } from "../../../../logic/composer";
import {
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "../../../../lib/terminalContext";
import {
  type ComposerAnnotationAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../../../stores/composer";

export function useChatViewComposerDraftActions(input: {
  threadId: ThreadId;
  promptRef: MutableRefObject<string>;
  composerTerminalContexts: TerminalContextDraft[];
  setPrompt: (nextPrompt: string) => void;
  setComposerDraftShellMode: (threadId: ThreadId, shellMode: boolean) => void;
  addComposerDraftImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addComposerDraftImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeComposerDraftImage: (threadId: ThreadId, imageId: string) => void;
  addComposerDraftFile: (threadId: ThreadId, file: ComposerFileAttachment) => void;
  addComposerDraftFiles: (threadId: ThreadId, files: ComposerFileAttachment[]) => void;
  removeComposerDraftFile: (threadId: ThreadId, fileId: string) => void;
  addComposerDraftAnnotations: (
    threadId: ThreadId,
    annotations: ComposerAnnotationAttachment[],
  ) => void;
  removeComposerDraftAnnotation: (threadId: ThreadId, annotationId: string) => void;
  addComposerDraftTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeComposerDraftTerminalContext: (threadId: ThreadId, contextId: string) => void;
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerTrigger: Dispatch<SetStateAction<ReturnType<typeof detectComposerTrigger>>>;
}) {
  const {
    threadId,
    promptRef,
    composerTerminalContexts,
    setPrompt,
    setComposerDraftShellMode,
    addComposerDraftImage,
    addComposerDraftImages,
    removeComposerDraftImage,
    addComposerDraftFile,
    addComposerDraftFiles,
    removeComposerDraftFile,
    addComposerDraftAnnotations,
    removeComposerDraftAnnotation,
    addComposerDraftTerminalContexts,
    removeComposerDraftTerminalContext,
    setComposerCursor,
    setComposerTrigger,
  } = input;

  const setComposerShellMode = useCallback(
    (shellMode: boolean) => {
      setComposerDraftShellMode(threadId, shellMode);
    },
    [setComposerDraftShellMode, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const addComposerFile = useCallback(
    (file: ComposerFileAttachment) => {
      addComposerDraftFile(threadId, file);
    },
    [addComposerDraftFile, threadId],
  );
  const addComposerFilesToDraft = useCallback(
    (files: ComposerFileAttachment[]) => {
      addComposerDraftFiles(threadId, files);
    },
    [addComposerDraftFiles, threadId],
  );
  const addComposerAnnotationsToDraft = useCallback(
    (annotations: ComposerAnnotationAttachment[]) => {
      addComposerDraftAnnotations(threadId, annotations);
    },
    [addComposerDraftAnnotations, threadId],
  );
  const removeComposerAnnotationFromDraft = useCallback(
    (annotationId: string) => {
      removeComposerDraftAnnotation(threadId, annotationId);
    },
    [removeComposerDraftAnnotation, threadId],
  );
  const removeComposerFileFromDraft = useCallback(
    (fileId: string) => {
      removeComposerDraftFile(threadId, fileId);
    },
    [removeComposerDraftFile, threadId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setComposerCursor,
      setComposerTrigger,
      setPrompt,
      threadId,
    ],
  );

  return {
    setComposerShellMode,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerTerminalContextsToDraft,
    removeComposerImageFromDraft,
    addComposerFile,
    addComposerFilesToDraft,
    addComposerAnnotationsToDraft,
    removeComposerAnnotationFromDraft,
    removeComposerFileFromDraft,
    removeComposerTerminalContextFromDraft,
  };
}
