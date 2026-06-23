import { useCallback, useRef } from "react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@bigbud/contracts";
import { randomUUID } from "~/lib/utils";

import { isElectron } from "~/config/env/env.config";
import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  parseFilesPanelDragEntry,
} from "../../../files/filesPanel.dnd";
import {
  BIGBUD_THREAD_CONTEXT_DRAG_MIME,
  parseThreadContextDragPayload,
} from "../../../sidebar/threadPanel.dnd";
import { toastManager } from "../../../ui/toast";

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

  const hasAcceptedDragData = useCallback((event: React.DragEvent<HTMLElement>) => {
    return (
      event.dataTransfer.types.includes("Files") ||
      event.dataTransfer.types.includes(BIGBUD_FILES_PANEL_DRAG_MIME) ||
      event.dataTransfer.types.includes(BIGBUD_THREAD_CONTEXT_DRAG_MIME)
    );
  }, []);

  const onComposerDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasAcceptedDragData(event)) {
        return;
      }
      event.preventDefault();
      base.dragDepthRef.current += 1;
      base.setIsDragOverComposer(true);
    },
    [base, hasAcceptedDragData],
  );

  const onComposerDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasAcceptedDragData(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      base.setIsDragOverComposer(true);
    },
    [base, hasAcceptedDragData],
  );

  const onComposerDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasAcceptedDragData(event)) {
        return;
      }
      event.preventDefault();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      base.dragDepthRef.current = Math.max(0, base.dragDepthRef.current - 1);
      if (base.dragDepthRef.current === 0) {
        base.setIsDragOverComposer(false);
      }
    },
    [base, hasAcceptedDragData],
  );

  const onComposerDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const hasNativeFiles = event.dataTransfer.types.includes("Files");
      const hasFilesPanelEntry = event.dataTransfer.types.includes(BIGBUD_FILES_PANEL_DRAG_MIME);
      const hasThreadContextEntry = event.dataTransfer.types.includes(
        BIGBUD_THREAD_CONTEXT_DRAG_MIME,
      );
      if (!hasNativeFiles && !hasFilesPanelEntry && !hasThreadContextEntry) return;
      event.preventDefault();
      base.dragDepthRef.current = 0;
      base.setIsDragOverComposer(false);

      if (hasThreadContextEntry && base.activeThreadId) {
        const payload = parseThreadContextDragPayload(
          event.dataTransfer.getData(BIGBUD_THREAD_CONTEXT_DRAG_MIME),
        );
        if (payload) {
          if (payload.threadId === base.activeThreadId) {
            toastManager.add({
              type: "error",
              title: "Cannot use a thread as context for itself.",
            });
            return;
          }
          const nextCount = base.composerFilesRef.current.length + base.composerImages.length;
          if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
            toastManager.add({
              type: "error",
              title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            });
            return;
          }
          base.addComposerFile({
            type: "file",
            id: randomUUID(),
            name: payload.title,
            mimeType: "application/x-bigbud-thread-reference",
            sizeBytes: 0,
            attachmentMode: "thread-reference",
            filePath: "",
            file: null,
            threadId: payload.threadId,
            threadTitle: payload.title,
          });
          runtime.focusComposer();
        }
        return;
      }

      if (hasFilesPanelEntry && base.activeThreadId) {
        const payload = parseFilesPanelDragEntry(
          event.dataTransfer.getData(BIGBUD_FILES_PANEL_DRAG_MIME),
        );
        if (payload) {
          const nextCount = base.composerFilesRef.current.length + base.composerImages.length;
          if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
            toastManager.add({
              type: "error",
              title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            });
          } else {
            base.addComposerFile({
              type: "file",
              id: randomUUID(),
              name: payload.name,
              mimeType: payload.entryKind === "directory" ? "inode/directory" : "text/plain",
              sizeBytes: 0,
              entryKind: payload.entryKind,
              attachmentMode: "path-reference",
              filePath: payload.path,
              file: null,
            });
          }
          runtime.focusComposer();
          return;
        }
      }

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
