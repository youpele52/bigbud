import type { BrowserAction, BrowserResult } from "@bigbud/contracts";
import type { DesktopCertificateChallenge } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";
import type { BrowserLoadFailure } from "./BrowserPanel.navigationError";

export interface BrowserViewportRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  inspectElement(x: number, y: number): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  startAnnotation(): Promise<import("./BrowserPanel.annotation").BrowserAnnotationResult | null>;
  cancelAnnotation(): Promise<void>;
  executeAgentAction(action: BrowserAction): Promise<BrowserResult>;
}

export interface BrowserPageMetadata {
  title: string;
  faviconUrl: string | null;
}

export interface BrowserViewportProps {
  url: string;
  onUrlChange?: ((url: string) => void) | undefined;
  onNavigationStateChange?:
    | ((state: { canGoBack: boolean; canGoForward: boolean }) => void)
    | undefined;
  onLoadStart?: (() => void) | undefined;
  onLoadSuccess?: (() => void) | undefined;
  onLoadFail?: ((info: BrowserLoadFailure) => void) | undefined;
  onCertificateChallengeChange?:
    | ((challenge: DesktopCertificateChallenge | null) => void)
    | undefined;
  onPageMetadataChange?: ((metadata: BrowserPageMetadata) => void) | undefined;
  onContextMenu?:
    | ((event: {
        x: number;
        y: number;
        pageURL?: string | undefined;
        linkURL?: string | undefined;
        linkText?: string | undefined;
        srcURL?: string | undefined;
        mediaType?: string | undefined;
        hasImageContents?: boolean | undefined;
        selectionText?: string | undefined;
        isEditable?: boolean | undefined;
        suggestedFilename?: string | undefined;
        editFlags?: BrowserEditFlags | undefined;
      }) => void)
    | undefined;
}

export interface BrowserEditFlags {
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

export type ElectronWebview = HTMLElement & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  inspectElement(x: number, y: number): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  capturePage(): Promise<{ toDataURL(): string }>;
};

export type NavigateEvent = Event & { url: string };
export type PageTitleEvent = Event & { title?: string };
export type PageFaviconEvent = Event & { favicons?: string[] };
export type ContextMenuEvent = Event & {
  params: {
    x: number;
    y: number;
    pageURL?: string;
    linkURL?: string;
    linkText?: string;
    srcURL?: string;
    mediaType?: string;
    hasImageContents?: boolean;
    selectionText?: string;
    isEditable?: boolean;
    suggestedFilename?: string;
    editFlags?: BrowserEditFlags;
  };
};
export type FailLoadEvent = Event & {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
};
