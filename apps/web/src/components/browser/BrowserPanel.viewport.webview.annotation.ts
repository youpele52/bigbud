import type { MutableRefObject } from "react";

import { isPdfPreviewUrl } from "~/lib/workspaceFilePreview";
import type {
  BrowserAnnotationResult,
  BrowserAnnotationSelection,
  BrowserAnnotationTheme,
} from "./BrowserPanel.annotation";
import type { ElectronWebview } from "./BrowserPanel.viewport.types";

export interface PendingPdfAnnotation {
  theme: BrowserAnnotationTheme;
  resolve: (selection: BrowserAnnotationSelection) => void;
}

export async function readIsPdfDocument(
  webview: ElectronWebview,
  inputUrl: string,
): Promise<boolean> {
  try {
    if (isPdfPreviewUrl(webview.getURL()) || isPdfPreviewUrl(inputUrl)) {
      return true;
    }
  } catch {
    if (isPdfPreviewUrl(inputUrl)) {
      return true;
    }
  }

  return webview
    .executeJavaScript<boolean>(
      `(() => {
        const href = (location.href || "").toLowerCase();
        const contentType =
          typeof document.contentType === "string" ? document.contentType.toLowerCase() : "";
        if (contentType === "application/pdf") return true;
        if (href.endsWith(".pdf") || href.includes(".pdf?")) return true;
        return Boolean(
          document.querySelector(
            'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"]',
          ),
        );
      })()`,
      false,
    )
    .catch(() => false);
}

export function waitForPdfAnnotationSelection(
  theme: BrowserAnnotationTheme,
  pendingPdfAnnotationRef: MutableRefObject<PendingPdfAnnotation | null>,
  setPendingPdfAnnotation: (pending: PendingPdfAnnotation | null) => void,
): Promise<BrowserAnnotationSelection> {
  return new Promise<BrowserAnnotationSelection>((resolve) => {
    const pending = { theme, resolve };
    pendingPdfAnnotationRef.current = pending;
    setPendingPdfAnnotation(pending);
  });
}

export async function captureBrowserAnnotation(
  webview: ElectronWebview,
  selection: Exclude<BrowserAnnotationSelection, { cancelled: true }>,
): Promise<BrowserAnnotationResult> {
  const screenshot = await webview.capturePage();
  return {
    comment: selection.comment,
    intent: selection.intent,
    page: {
      url: webview.getURL(),
      title: webview.getTitle(),
    },
    element: selection.element,
    viewport: selection.viewport,
    screenshot: {
      mime: "image/png",
      dataUrl: screenshot.toDataURL(),
    },
  };
}

export async function waitForNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
