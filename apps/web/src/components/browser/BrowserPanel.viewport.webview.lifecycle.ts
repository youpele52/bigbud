import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";

import { makeWebviewCertificateChallengeController } from "./BrowserPanel.certificateChallenge.webview";
import { navigateElectronWebview } from "./BrowserPanel.viewport.webview.navigate";
import type {
  BrowserPageMetadata,
  ContextMenuEvent,
  ElectronWebview,
  FailLoadEvent,
  FrameFinishLoadEvent,
  NavigateEvent,
  PageFaviconEvent,
  PageTitleEvent,
  StartNavigationEvent,
} from "./BrowserPanel.viewport.types";
import {
  browserSameTabPopupGuardScript,
  isWebviewReady,
  normalizeBrowserUrl,
} from "./BrowserPanel.viewport.webview.utils";

interface BindWebviewLifecycleOptions {
  readonly bridge: DesktopBridge | undefined;
  readonly getUrl: () => string;
  readonly onCertificateChallengeChange: (
    challenge: Parameters<
      NonNullable<
        import("./BrowserPanel.viewport.types").BrowserViewportProps["onCertificateChallengeChange"]
      >
    >[0],
  ) => void;
  readonly onContextMenu: (
    event: Parameters<
      NonNullable<import("./BrowserPanel.viewport.types").BrowserViewportProps["onContextMenu"]>
    >[0],
  ) => void;
  readonly onLoadFail: (
    failure: Parameters<
      NonNullable<import("./BrowserPanel.viewport.types").BrowserViewportProps["onLoadFail"]>
    >[0],
  ) => void;
  readonly onLoadStart: () => void;
  readonly onLoadStop: () => void;
  readonly onLoadSuccess: () => void;
  readonly onWebviewStateChange: (
    state: import("./BrowserPanel.viewport.types").BrowserWebviewState | null,
  ) => void;
  readonly onNavigationStateChange: (state: { canGoBack: boolean; canGoForward: boolean }) => void;
  readonly onNavigationCommit: (url: string) => void;
  readonly onPageMetadataChange: (metadata: BrowserPageMetadata, url?: string) => void;
  readonly onUrlChange: (url: string) => void;
  readonly webview: ElectronWebview;
}

export function bindWebviewLifecycle({
  bridge,
  getUrl,
  onCertificateChallengeChange,
  onContextMenu,
  onLoadFail,
  onLoadStart,
  onLoadStop,
  onLoadSuccess,
  onWebviewStateChange,
  onNavigationCommit,
  onNavigationStateChange,
  onPageMetadataChange,
  onUrlChange,
  webview,
}: BindWebviewLifecycleOptions): () => void {
  const certificateChallengeController = makeWebviewCertificateChallengeController({
    bridge,
    webview,
    onChallenge: onCertificateChallengeChange,
    onFailure: onLoadFail,
  });
  let failedLoad = false;
  let committedUrl: string | undefined;
  let pageMetadata: BrowserPageMetadata = { title: "", faviconUrl: null };
  let metadataGeneration = 0;
  let active = true;

  const updateNavState = () => {
    if (!isWebviewReady(webview)) return;
    try {
      onNavigationStateChange({
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      });
    } catch {
      // Guest frame may not be ready yet; ignore transient state reads.
    }
  };
  const updatePageMetadata = (metadata: Partial<BrowserPageMetadata>, url = committedUrl) => {
    const next = {
      title: metadata.title ?? pageMetadata.title,
      faviconUrl:
        metadata.faviconUrl === undefined
          ? pageMetadata.faviconUrl
          : normalizeBrowserUrl(metadata.faviconUrl),
    };
    pageMetadata = next;
    try {
      onPageMetadataChange(next, url);
    } catch {
      // Ignore transient callback errors during navigation.
    }
  };
  const readPageMetadata = () => {
    if (!isWebviewReady(webview)) return;
    let currentUrl = committedUrl;
    const generation = metadataGeneration;
    try {
      currentUrl = webview.getURL();
      updatePageMetadata({ title: webview.getTitle() || "" }, currentUrl);
    } catch {
      // Guest frame may not be ready yet; ignore transient state reads.
    }
    void webview
      .executeJavaScript<BrowserPageMetadata | null>(
        `(() => {
          const icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="apple-touch-icon"]');
          const href = icon instanceof HTMLLinkElement && icon.href ? icon.href : null;
          return { title: document.title || "", faviconUrl: href };
        })()`,
        false,
      )
      .then((metadata) => {
        if (!metadata || !active || generation !== metadataGeneration) return;
        try {
          if (webview.getURL() !== currentUrl) return;
        } catch {
          return;
        }
        updatePageMetadata(metadata, currentUrl);
      })
      .catch(() => {
        // Cross-origin and transient navigation states can reject script execution.
      });
  };
  const installSameTabPopupGuard = () => {
    if (!isWebviewReady(webview)) return;
    void webview.executeJavaScript(browserSameTabPopupGuardScript, false).catch(() => {
      // Ignore transient script-injection failures during navigation.
    });
  };
  const handleNavigate = (event: NavigateEvent) => {
    metadataGeneration += 1;
    updateNavState();
    if (!event.url) return;
    try {
      onUrlChange(event.url);
      updatePageMetadata({ title: "", faviconUrl: null });
    } catch {
      // Ignore transient callback errors during navigation.
    }
  };
  const handleMainFrameNavigate = (event: NavigateEvent) => {
    committedUrl = event.url;
    handleNavigate(event);
    if (event.url) onNavigationCommit(event.url);
  };
  const handlePageTitle = (event: PageTitleEvent) =>
    updatePageMetadata({ title: event.title || "" });
  const handlePageFavicon = (event: PageFaviconEvent) =>
    updatePageMetadata({ faviconUrl: event.favicons?.[0] ?? null });
  const handleFailLoad = (event: FailLoadEvent) => {
    if (!event.isMainFrame || event.errorCode === -3) return;
    failedLoad = true;
    try {
      onLoadFail({
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        validatedURL: event.validatedURL,
      });
    } catch {
      // Ignore transient callback errors.
    }
  };
  const handleMainFrameStart = (event: StartNavigationEvent) => {
    if (!event.isMainFrame) return;
    metadataGeneration += 1;
    certificateChallengeController.rejectPending();
    failedLoad = false;
    onLoadStart();
  };
  const handleMainFrameFinish = (event: FrameFinishLoadEvent) => {
    if (event.isMainFrame && !failedLoad) onLoadSuccess();
  };
  const handleStopLoading = () => onLoadStop();
  const handleRenderProcessGone = () => {
    onLoadStop();
    onWebviewStateChange("crashed");
  };
  const handleUnresponsive = () => onWebviewStateChange("unresponsive");
  const handleResponsive = () => onWebviewStateChange(null);
  const handleContextMenu = (event: ContextMenuEvent) => {
    const params = event.params;
    if (!params) return;
    try {
      onContextMenu({
        x: params.x,
        y: params.y,
        pageURL: params.pageURL,
        linkURL: params.linkURL,
        linkText: params.linkText,
        srcURL: params.srcURL,
        mediaType: params.mediaType,
        hasImageContents: params.hasImageContents,
        selectionText: params.selectionText,
        isEditable: params.isEditable,
        suggestedFilename: params.suggestedFilename,
        editFlags: params.editFlags,
      });
    } catch {
      // Ignore transient callback errors during context menu.
    }
  };
  const handleAttach = () => {
    navigateElectronWebview(webview, getUrl());
  };

  webview.addEventListener("did-attach", handleAttach);
  webview.addEventListener("did-navigate", handleMainFrameNavigate as EventListener);
  webview.addEventListener("did-navigate-in-page", handleNavigate as EventListener);
  webview.addEventListener("dom-ready", updateNavState);
  webview.addEventListener("dom-ready", readPageMetadata);
  webview.addEventListener("dom-ready", installSameTabPopupGuard);
  webview.addEventListener("page-title-updated", handlePageTitle as EventListener);
  webview.addEventListener("page-favicon-updated", handlePageFavicon as EventListener);
  webview.addEventListener("did-fail-load", handleFailLoad as EventListener);
  webview.addEventListener("did-start-navigation", handleMainFrameStart as EventListener);
  webview.addEventListener("did-frame-finish-load", handleMainFrameFinish as EventListener);
  webview.addEventListener("did-stop-loading", handleStopLoading);
  webview.addEventListener("render-process-gone", handleRenderProcessGone);
  webview.addEventListener("unresponsive", handleUnresponsive);
  webview.addEventListener("responsive", handleResponsive);
  webview.addEventListener("context-menu", handleContextMenu as EventListener);

  return () => {
    active = false;
    certificateChallengeController.unsubscribe();
    webview.removeEventListener("did-attach", handleAttach);
    webview.removeEventListener("did-navigate", handleMainFrameNavigate as EventListener);
    webview.removeEventListener("did-navigate-in-page", handleNavigate as EventListener);
    webview.removeEventListener("dom-ready", updateNavState);
    webview.removeEventListener("dom-ready", readPageMetadata);
    webview.removeEventListener("dom-ready", installSameTabPopupGuard);
    webview.removeEventListener("page-title-updated", handlePageTitle as EventListener);
    webview.removeEventListener("page-favicon-updated", handlePageFavicon as EventListener);
    webview.removeEventListener("did-fail-load", handleFailLoad as EventListener);
    webview.removeEventListener("did-start-navigation", handleMainFrameStart as EventListener);
    webview.removeEventListener("did-frame-finish-load", handleMainFrameFinish as EventListener);
    webview.removeEventListener("did-stop-loading", handleStopLoading);
    webview.removeEventListener("render-process-gone", handleRenderProcessGone);
    webview.removeEventListener("unresponsive", handleUnresponsive);
    webview.removeEventListener("responsive", handleResponsive);
    webview.removeEventListener("context-menu", handleContextMenu as EventListener);
  };
}
