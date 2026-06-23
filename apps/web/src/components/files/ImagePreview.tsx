import { AlertCircleIcon, XIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { buildWorkspaceFilePreviewUrl } from "../../lib/workspaceFilePreview";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { buildFilePreviewBreadcrumb } from "./FilePreview.logic";

interface ImagePreviewProps {
  cwd: string;
  relativePath: string;
  projectName?: string | undefined;
  onBack?: (() => void) | undefined;
}

export const ImagePreview = memo(function ImagePreview({
  cwd,
  relativePath,
  projectName,
  onBack,
}: ImagePreviewProps) {
  const [loadError, setLoadError] = useState(false);
  const breadcrumb = useMemo(
    () => buildFilePreviewBreadcrumb(projectName, cwd, relativePath),
    [cwd, projectName, relativePath],
  );
  const imageUrl = useMemo(
    () =>
      buildWorkspaceFilePreviewUrl({
        cwd,
        relativePath,
      }),
    [cwd, relativePath],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs">
            {breadcrumb.map((part, index) => (
              <span key={part.id} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="text-muted-foreground/45">&gt;</span> : null}
                <span
                  className={cn(
                    "truncate",
                    index === breadcrumb.length - 1
                      ? "font-medium text-foreground"
                      : "text-muted-foreground/75",
                  )}
                  title={part.label}
                >
                  {part.label}
                </span>
              </span>
            ))}
          </div>
        </div>
        {onBack ? (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Close">
            <XIcon />
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {loadError ? (
          <div className="flex gap-2 p-3 text-sm text-destructive/80">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>Failed to load image preview.</span>
          </div>
        ) : (
          <img
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
