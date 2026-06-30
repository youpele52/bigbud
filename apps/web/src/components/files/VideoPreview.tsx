import { AlertCircleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { buildWorkspaceFilePreviewUrl } from "../../lib/workspaceFilePreview";
import { openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { buildAbsolutePreviewPath, buildFilePreviewBreadcrumb } from "./FilePreview.logic";
import { FilePreviewHeader } from "./FilePreviewHeader";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";

interface VideoPreviewProps {
  cwd: string;
  relativePath: string;
  executionTargetId?: string | undefined;
  projectName?: string | undefined;
  onBack?: (() => void) | undefined;
}

export const VideoPreview = memo(function VideoPreview({
  cwd,
  relativePath,
  executionTargetId,
  projectName,
  onBack,
}: VideoPreviewProps) {
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
  const videoUrl = useMemo(() => {
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

  const handleOpenExternally = useCallback(() => {
    const api = readNativeApi();
    if (!api) return;
    void openPathInPreferredApp(api, absolutePath).catch((error) => {
      console.error("Failed to open file:", error);
    });
  }, [absolutePath]);

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
          <div className="flex max-w-sm flex-col items-center gap-3 p-3 text-center text-sm text-destructive/80">
            <div className="flex gap-2">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                Failed to load video preview. The codec may not be supported in this browser.
              </span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleOpenExternally}>
              Open in default app
            </Button>
          </div>
        ) : (
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            playsInline
            preload="metadata"
            className="max-h-full max-w-full"
            onError={() => setLoadError(true)}
          >
            <track kind="captions" />
          </video>
        )}
      </div>
    </div>
  );
});
