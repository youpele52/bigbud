import { AlertCircleIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { buildWorkspaceFilePreviewUrl } from "../../lib/workspaceFilePreview";
import { showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { buildAbsolutePreviewPath, buildFilePreviewBreadcrumb } from "./FilePreview.logic";
import { FilePreviewHeader } from "./FilePreviewHeader";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";
import type { FilePreviewNavigationProps } from "./FilePreview.types";
import { BigbudLoader } from "../layout/BigbudLoader";
import { getMediaPreviewPhase } from "./mediaPreviewState";

interface ImagePreviewProps extends FilePreviewNavigationProps {
  cwd: string;
  relativePath: string;
  executionTargetId?: string | undefined;
  projectName?: string | undefined;
}

export const ImagePreview = memo(function ImagePreview({
  cwd,
  relativePath,
  executionTargetId,
  projectName,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
  onClose,
  onPreviewLoadError,
}: ImagePreviewProps) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const breadcrumb = useMemo(
    () => buildFilePreviewBreadcrumb(projectName, cwd, relativePath),
    [cwd, projectName, relativePath],
  );
  const absolutePath = useMemo(
    () => buildAbsolutePreviewPath(cwd, relativePath),
    [cwd, relativePath],
  );
  const refreshPreview = useCallback(() => {
    setPreviewVersion((current) => current + 1);
  }, []);
  const imageUrl = useMemo(() => {
    const url = buildWorkspaceFilePreviewUrl({
      cwd,
      relativePath,
      executionTargetId,
    });
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${previewVersion}`;
  }, [cwd, executionTargetId, previewVersion, relativePath]);

  useFilePreviewRefresh({
    cwd,
    relativePath,
    executionTargetId,
    refreshPreview,
  });

  const phase = getMediaPreviewPhase({ url: imageUrl, loadedUrl, errorUrl });
  const loadError = phase === "error";
  const loading = phase === "loading";

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();

      void showFilePreviewContextMenu({
        position: { x: event.clientX, y: event.clientY },
        absolutePath,
        relativePath,
        selectedText: "",
        canSelectAll: false,
      });
    },
    [absolutePath, relativePath],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <FilePreviewHeader
        breadcrumb={breadcrumb}
        absolutePath={absolutePath}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onNavigateBack={onNavigateBack}
        onNavigateForward={onNavigateForward}
        onClose={onClose}
        onContextMenu={handleContextMenu}
      />
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
        onContextMenu={handleContextMenu}
      >
        {loadError ? (
          <div className="flex gap-2 p-3 text-sm text-destructive/80">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>Failed to load image preview.</span>
          </div>
        ) : (
          <>
            {loading ? (
              <div className="absolute inset-0">
                <BigbudLoader label="Loading image preview..." />
              </div>
            ) : null}
            <img
              key={imageUrl}
              src={imageUrl}
              alt={breadcrumb.at(-1)?.label ?? relativePath}
              className={`max-h-full max-w-full object-contain ${loading ? "invisible" : ""}`}
              onLoad={() => {
                setLoadedUrl(imageUrl);
                setErrorUrl(null);
              }}
              onError={() => {
                setErrorUrl(imageUrl);
                onPreviewLoadError?.();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
});
