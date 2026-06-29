import { AlertCircleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { buildWorkspaceFilePreviewUrl } from "../../lib/workspaceFilePreview";
import { showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { buildAbsolutePreviewPath, buildFilePreviewBreadcrumb } from "./FilePreview.logic";
import { FilePreviewHeader } from "./FilePreviewHeader";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";

interface ImagePreviewProps {
  cwd: string;
  relativePath: string;
  executionTargetId?: string | undefined;
  projectName?: string | undefined;
  onBack?: (() => void) | undefined;
}

export const ImagePreview = memo(function ImagePreview({
  cwd,
  relativePath,
  executionTargetId,
  projectName,
  onBack,
}: ImagePreviewProps) {
  const [loadError, setLoadError] = useState(false);
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
    setLoadError(false);
    setPreviewVersion((current) => current + 1);
  }, []);
  const imageUrl = useMemo(() => {
    const url = buildWorkspaceFilePreviewUrl({
      cwd,
      relativePath,
    });
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${previewVersion}`;
  }, [cwd, previewVersion, relativePath]);

  useFilePreviewRefresh({
    cwd,
    relativePath,
    executionTargetId,
    refreshPreview,
  });

  useEffect(() => {
    setLoadError(false);
    setPreviewVersion(0);
  }, [relativePath]);

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
        onBack={onBack}
        onContextMenu={handleContextMenu}
      />
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
        onContextMenu={handleContextMenu}
      >
        {loadError ? (
          <div className="flex gap-2 p-3 text-sm text-destructive/80">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>Failed to load image preview.</span>
          </div>
        ) : (
          <img
            key={imageUrl}
            src={imageUrl}
            alt={breadcrumb.at(-1)?.label ?? relativePath}
            className="max-h-full max-w-full object-contain"
            onError={() => setLoadError(true)}
          />
        )}
      </div>
    </div>
  );
});
