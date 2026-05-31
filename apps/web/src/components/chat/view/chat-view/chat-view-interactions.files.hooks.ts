import { useCallback, useRef } from "react";

import { isElectron } from "~/config/env/env.config";

import { useAddComposerFiles, useAddComposerImages } from "../ChatView.composerHandlers.logic";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface UseChatViewInteractionFilesInput {
  base: ChatViewBaseState;
  thread: ChatViewThreadDerivedState;
  runtime: ChatViewRuntimeState;
}

export function useChatViewInteractionFiles({
  base,
  thread,
  runtime,
}: UseChatViewInteractionFilesInput) {
  const addComposerImages = useAddComposerImages({
    activeThreadId: base.activeThreadId,
    composerImagesRef: base.composerImagesRef,
    pendingUserInputsLength: thread.pendingUserInputs.length,
    addComposerImage: base.addComposerImage,
    addComposerImagesToDraft: base.addComposerImagesToDraft,
    setThreadError: runtime.setThreadError,
  });

  const addComposerFiles = useAddComposerFiles({
    activeThreadId: base.activeThreadId,
    composerFilesRef: base.composerFilesRef,
    composerImagesLength: base.composerImages.length,
    pendingUserInputsLength: thread.pendingUserInputs.length,
    addComposerFile: base.addComposerFile,
    addComposerFilesToDraft: base.addComposerFilesToDraft,
    setThreadError: runtime.setThreadError,
    isElectron,
  });

  const onComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const allFiles = Array.from(event.clipboardData.files);
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      const nonImageFiles = allFiles.filter((file) => !file.type.startsWith("image/"));
      if (imageFiles.length > 0) {
        event.preventDefault();
        addComposerImages(imageFiles);
      }
      if (nonImageFiles.length > 0) {
        event.preventDefault();
        addComposerFiles(nonImageFiles);
      }
    },
    [addComposerFiles, addComposerImages],
  );

  const onComposerDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      base.dragDepthRef.current += 1;
      base.setIsDragOverComposer(true);
    },
    [base],
  );

  const onComposerDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      base.setIsDragOverComposer(true);
    },
    [base],
  );

  const onComposerDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      base.dragDepthRef.current = Math.max(0, base.dragDepthRef.current - 1);
      if (base.dragDepthRef.current === 0) {
        base.setIsDragOverComposer(false);
      }
    },
    [base],
  );

  const onComposerDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      base.dragDepthRef.current = 0;
      base.setIsDragOverComposer(false);
      const allFiles = Array.from(event.dataTransfer.files);
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      const nonImageFiles = allFiles.filter((file) => !file.type.startsWith("image/"));
      if (imageFiles.length > 0) addComposerImages(imageFiles);
      if (nonImageFiles.length > 0) addComposerFiles(nonImageFiles);
      runtime.focusComposer();
    },
    [addComposerFiles, addComposerImages, base, runtime],
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onAttachFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const allFiles = Array.from(event.target.files ?? []);
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      const nonImageFiles = allFiles.filter((file) => !file.type.startsWith("image/"));
      if (imageFiles.length > 0) addComposerImages(imageFiles);
      if (nonImageFiles.length > 0) addComposerFiles(nonImageFiles);
      event.target.value = "";
      runtime.focusComposer();
    },
    [addComposerFiles, addComposerImages, runtime],
  );

  return {
    addComposerFiles,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onAttachFiles,
    fileInputRef,
    onFileInputChange,
  };
}
