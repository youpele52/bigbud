import { useCallback, useState, type RefObject } from "react";
import type { ThreadId } from "@bigbud/contracts";

import { randomUUID } from "~/lib/utils";
import { useComposerDraftStore } from "~/stores/composer";
import { normalizeAnnotationComment } from "~/stores/composer/types.annotation.store";
import { toastManager } from "../ui/toast";
import { dataUrlToFile } from "./BrowserPanel.annotation";
import { cropBrowserAnnotationImage } from "./BrowserPanel.annotation.image";
import type { BrowserViewportRef } from "./BrowserPanel.viewport";

interface UseBrowserAnnotationOptions {
  readonly activeThreadId: ThreadId | null;
  readonly viewportRef: RefObject<BrowserViewportRef | null>;
}

export function useBrowserAnnotation({ activeThreadId, viewportRef }: UseBrowserAnnotationOptions) {
  const addComposerImage = useComposerDraftStore((state) => state.addImage);
  const addComposerAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const [annotationActive, setAnnotationActive] = useState(false);

  const cancelAnnotation = useCallback(async () => {
    setAnnotationActive(false);
    await viewportRef.current?.cancelAnnotation();
  }, [viewportRef]);

  const handleAnnotate = useCallback(async () => {
    if (annotationActive) {
      await cancelAnnotation().catch(() => undefined);
      return;
    }

    if (!activeThreadId) {
      toastManager.add({ type: "error", title: "Open a thread before annotating." });
      return;
    }

    setAnnotationActive(true);
    try {
      const annotation = await viewportRef.current?.startAnnotation();
      setAnnotationActive(false);
      if (!annotation) return;

      const screenshotDataUrl =
        (await cropBrowserAnnotationImage({
          dataUrl: annotation.screenshot.dataUrl,
          element: annotation.element,
          viewport: annotation.viewport,
        })) ?? annotation.screenshot.dataUrl;

      const file = dataUrlToFile(
        screenshotDataUrl,
        "browser-annotation.png",
        annotation.screenshot.mime,
      );
      if (!file) {
        toastManager.add({ type: "error", title: "Could not capture browser screenshot." });
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      const imageId = randomUUID();
      addComposerImage(activeThreadId, {
        type: "image",
        id: imageId,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      addComposerAnnotation(activeThreadId, {
        id: randomUUID(),
        imageId,
        comment: normalizeAnnotationComment(annotation.comment),
        intent: annotation.intent,
        page: annotation.page,
        element: annotation.element,
        viewport: annotation.viewport,
        createdAt: new Date().toISOString(),
      });
      toastManager.add({
        type: "success",
        title: "Annotation added to composer",
        data: { threadId: activeThreadId, dismissAfterVisibleMs: 3000 },
      });
    } catch (error) {
      setAnnotationActive(false);
      toastManager.add({
        type: "error",
        title: "Browser annotation failed",
        description: error instanceof Error ? error.message : String(error),
        data: { threadId: activeThreadId },
      });
    }
  }, [
    activeThreadId,
    addComposerAnnotation,
    addComposerImage,
    annotationActive,
    cancelAnnotation,
    viewportRef,
  ]);

  return { annotationActive, cancelAnnotation, handleAnnotate };
}
