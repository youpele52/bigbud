export interface BrowserViewportRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  startAnnotation(): Promise<import("./BrowserPanel.annotation").BrowserAnnotationResult | null>;
  cancelAnnotation(): Promise<void>;
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
  onLoadFail?:
    | ((info: { errorCode: number; errorDescription: string; validatedURL: string }) => void)
    | undefined;
  onPageMetadataChange?: ((metadata: BrowserPageMetadata) => void) | undefined;
  onContextMenu?:
    | ((event: {
        x: number;
        y: number;
        linkURL?: string | undefined;
        selectionText?: string | undefined;
      }) => void)
    | undefined;
}

export type ElectronWebview = HTMLElement & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
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
    linkURL?: string;
    selectionText?: string;
  };
};
export type FailLoadEvent = Event & {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
};
