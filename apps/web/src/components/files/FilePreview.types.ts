export interface FilePreviewNavigationProps {
  readonly canNavigateBack: boolean;
  readonly canNavigateForward: boolean;
  readonly onNavigateBack: () => void;
  readonly onNavigateForward: () => void;
  readonly onClose?: (() => void) | undefined;
  readonly onPreviewLoadError?: ((error?: unknown) => void) | undefined;
}

export interface FilePreviewScrollProps {
  readonly initialScrollTop?: number | null | undefined;
  readonly onScrollPositionChange?: ((scrollTop: number) => void) | undefined;
}
