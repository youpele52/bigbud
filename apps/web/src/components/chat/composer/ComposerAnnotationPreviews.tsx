import { MousePointerSquareDashedIcon } from "lucide-react";
import type {
  ComposerAnnotationAttachment,
  ComposerImageAttachment,
} from "../../../stores/composer";
import { isCodeAnnotationAttachment } from "../../../stores/composer";
import {
  StructuredAnnotationPreviews,
  type StructuredAnnotationPreviewItem,
} from "./StructuredAnnotationPreviews";

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
  const items: StructuredAnnotationPreviewItem[] = annotations.map((annotation, index) => {
    if (isCodeAnnotationAttachment(annotation)) {
      const lineLabel =
        annotation.selection.startLine === annotation.selection.endLine
          ? `Line ${annotation.selection.startLine}`
          : `Lines ${annotation.selection.startLine}-${annotation.selection.endLine}`;
      return {
        id: annotation.id,
        thumbnail: null,
        title: annotation.comment.trim() || "No instruction provided",
        badge: (
          <span className="shrink-0 rounded bg-info/15 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info">
            code
          </span>
        ),
        subtitle: annotation.file.projectName
          ? `${annotation.file.projectName} > ${annotation.file.relativePath}`
          : annotation.file.relativePath,
        detail: lineLabel,
        removeLabel: `Remove annotation ${index + 1}`,
      };
    }
    const image = imageById.get(annotation.imageId);
    return {
      id: annotation.id,
      thumbnail: image ? (
        <img
          src={image.previewUrl}
          alt={`Annotation ${index + 1} screenshot`}
          className="h-full w-full object-cover"
        />
      ) : null,
      title: annotation.comment.trim() || "No instruction provided",
      badge: (
        <span
          className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide"
          style={{
            backgroundColor:
              annotation.intent === "fix"
                ? "rgb(254 226 226)"
                : annotation.intent === "context"
                  ? "rgb(254 249 195)"
                  : "rgb(219 234 254)",
            color:
              annotation.intent === "fix"
                ? "rgb(153 27 27)"
                : annotation.intent === "context"
                  ? "rgb(161 98 7)"
                  : "rgb(29 78 216)",
          }}
        >
          {annotation.intent}
        </span>
      ),
      subtitle: annotation.page.title || annotation.page.url,
      detail: annotation.element.selector || annotation.element.tag,
      removeLabel: `Remove annotation ${index + 1}`,
    };
  });

  return (
    <StructuredAnnotationPreviews
      triggerIcon={<MousePointerSquareDashedIcon className="size-3.5 text-info" />}
      label={annotationLabel(annotations.length)}
      clearLabel={annotations.length === 1 ? "Remove annotation" : "Remove all annotations"}
      items={items}
      onRemoveItem={onRemoveAnnotation}
      onClear={onClearAnnotations}
    />
  );
}
