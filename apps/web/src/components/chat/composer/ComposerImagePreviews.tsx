import { CircleAlertIcon, XIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "../common/ExpandedImagePreview";
import type { ComposerImageAttachment } from "../../../stores/composer";

interface ComposerImagePreviewsProps {
  composerImages: ComposerImageAttachment[];
  nonPersistedComposerImageIdSet: Set<string>;
  onRemoveImage: (imageId: string) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

export function ComposerImagePreviews({
  composerImages,
  nonPersistedComposerImageIdSet,
  onRemoveImage,
  onExpandImage,
}: ComposerImagePreviewsProps) {
  if (composerImages.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {composerImages.map((image) => (
        <div
          key={image.id}
          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(composerImages, image.id);
                if (!preview) return;
                onExpandImage(preview);
              }}
            >
              <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
              {image.name}
            </div>
          )}
          {nonPersistedComposerImageIdSet.has(image.id) && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Draft attachment may not persist"
                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                  >
                    <CircleAlertIcon className="size-3" />
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
                Draft attachment could not be saved locally and may be lost on navigation.
              </TooltipPopup>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
            onClick={() => onRemoveImage(image.id)}
            aria-label={`Remove ${image.name}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}
