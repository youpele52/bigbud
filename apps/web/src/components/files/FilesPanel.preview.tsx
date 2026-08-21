import { isImageFilePath, isVideoFilePath } from "../../lib/workspaceFilePreview";
import type { FileHistoryEntry } from "../../stores/files/filesPanel.history";
import { FilePreview, type CodeAnnotationDraft } from "./FilePreview";
import type { FilePreviewNavigationProps } from "./FilePreview.types";
import { ImagePreview } from "./ImagePreview";
import { IpynbPreview } from "./IpynbPreview";
import { VideoPreview } from "./VideoPreview";

interface FilesPanelPreviewProps extends FilePreviewNavigationProps {
  readonly cwd: string;
  readonly relativePath: string;
  readonly historyEntry?: FileHistoryEntry | undefined;
  readonly targetLine?: number | undefined;
  readonly executionTargetId?: string | undefined;
  readonly projectName?: string | undefined;
  readonly onScrollPositionChange: (scrollTop: number) => void;
  readonly onCreateAnnotation?: ((annotation: CodeAnnotationDraft) => void) | undefined;
  readonly onSearchMatch?: ((line: number) => void) | undefined;
}

export function FilesPanelPreview(props: FilesPanelPreviewProps) {
  const sharedProps = {
    cwd: props.cwd,
    relativePath: props.relativePath,
    executionTargetId: props.executionTargetId,
    projectName: props.projectName,
    canNavigateBack: props.canNavigateBack,
    canNavigateForward: props.canNavigateForward,
    onNavigateBack: props.onNavigateBack,
    onNavigateForward: props.onNavigateForward,
    onClose: props.onClose,
  };
  if (isImageFilePath(props.relativePath)) return <ImagePreview {...sharedProps} />;
  if (isVideoFilePath(props.relativePath)) return <VideoPreview {...sharedProps} />;

  const scrollProps = {
    ...sharedProps,
    onPreviewLoadError: props.onPreviewLoadError,
    targetLine: props.targetLine,
    initialScrollTop: props.historyEntry?.scrollTop,
    onScrollPositionChange: props.onScrollPositionChange,
    onCreateAnnotation: props.onCreateAnnotation,
    onSearchMatch: props.onSearchMatch,
  };
  return props.relativePath.toLowerCase().endsWith(".ipynb") ? (
    <IpynbPreview {...scrollProps} />
  ) : (
    <FilePreview {...scrollProps} />
  );
}
