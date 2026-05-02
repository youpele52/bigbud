import { MousePointerSquareDashedIcon, XIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import type {
  ComposerAnnotationAttachment,
  ComposerImageAttachment,
} from "../../../stores/composer";

interface ComposerAnnotationPreviewsProps {
  annotations: ComposerAnnotationAttachment[];
  images: ComposerImageAttachment[];
  onRemoveAnnotation: (annotationId: string) => void;
  onClearAnnotations: () => void;
}

function annotationLabel(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

export function ComposerAnnotationPreviews({
  annotations,
  images,
  onRemoveAnnotation,
  onClearAnnotations,
}: ComposerAnnotationPreviewsProps) {
  if (annotations.length === 0) return null;
  const imageById = new Map(images.map((image) => [image.id, image]));

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      <Popover>
        <div className="group inline-flex items-center gap-1 rounded-lg border border-border/80 bg-background px-1 py-1">
          <PopoverTrigger
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-foreground/80 transition-colors hover:bg-muted/60"
            aria-label={`Show ${annotationLabel(annotations.length)}`}
          >
            <MousePointerSquareDashedIcon className="size-3.5 text-info" />
            <span>{annotationLabel(annotations.length)}</span>
          </PopoverTrigger>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-60 transition-opacity hover:opacity-100 group-hover:opacity-100"
            onClick={onClearAnnotations}
            aria-label={annotations.length === 1 ? "Remove annotation" : "Remove all annotations"}
          >
            <XIcon />
          </Button>
        </div>
        <PopoverPopup align="start" side="top" className="w-[min(420px,calc(100vw-2rem))] p-0">
          <div className="max-h-80 space-y-2 overflow-y-auto p-3">
            {annotations.map((annotation, index) => {
              const image = imageById.get(annotation.imageId);
              return (
                <div
                  key={annotation.id}
                  className="group grid grid-cols-[56px_minmax(0,1fr)_auto] gap-3 rounded-lg border border-border/80 bg-background p-2"
                >
                  <div className="h-14 w-14 overflow-hidden rounded-md border border-border/70 bg-muted">
                    {image ? (
                      <img
                        src={image.previewUrl}
                        alt={`Annotation ${index + 1} screenshot`}
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="truncate text-xs font-medium text-foreground">
                      {annotation.comment.trim() || "No instruction provided"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {annotation.page.title || annotation.page.url}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                      {annotation.element.selector || annotation.element.tag}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => onRemoveAnnotation(annotation.id)}
                    aria-label={`Remove annotation ${index + 1}`}
                  >
                    <XIcon />
                  </Button>
                </div>
              );
            })}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
