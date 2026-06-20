import {
  isCodeAnnotationAttachment,
  type ComposerAnnotationAttachment,
} from "../../../stores/composer";
import {
  normalizeAnnotationComment,
  normalizeBrowserAnnotationElement,
  normalizeBrowserAnnotationPage,
  normalizeBrowserAnnotationViewport,
  type ComposerCodeAnnotationAttachment,
} from "../../../stores/composer/types.annotation.store";

export function buildCodeAnnotationPrompt(annotation: ComposerCodeAnnotationAttachment): string {
  const userInstruction = normalizeAnnotationComment(annotation.comment).trim();
  const normalizedInstruction = userInstruction || "(no instruction provided)";
  const lineLabel =
    annotation.selection.startLine === annotation.selection.endLine
      ? `Line: ${annotation.selection.startLine}`
      : `Lines: ${annotation.selection.startLine}-${annotation.selection.endLine}`;
  const closingLine =
    annotation.intent === "fix"
      ? "Use the selected code and user instruction to make the appropriate code change."
      : annotation.intent === "context"
        ? "Use the selected code as context when responding."
        : undefined;
  const lines = [
    "Code annotation",
    "",
    "User instruction:",
    normalizedInstruction,
    "",
    "File:",
    ...(annotation.file.projectName ? [`Project: ${annotation.file.projectName}`] : []),
    `Workspace: ${annotation.file.cwd}`,
    `Path: ${annotation.file.relativePath}`,
    lineLabel,
    "",
    "Selected code:",
    "```",
    annotation.selection.text,
    "```",
  ];

  if (closingLine) {
    lines.push("", closingLine);
  }

  return lines.join("\n");
}

export function buildBrowserAnnotationPrompt(annotation: ComposerAnnotationAttachment): string {
  if (isCodeAnnotationAttachment(annotation)) {
    return buildCodeAnnotationPrompt(annotation);
  }
  const element = normalizeBrowserAnnotationElement(annotation.element);
  const page = normalizeBrowserAnnotationPage(annotation.page);
  const viewport = normalizeBrowserAnnotationViewport(annotation.viewport);
  const { intent } = annotation;
  const rect = element.rect;
  const userInstruction = normalizeAnnotationComment(annotation.comment).trim();
  const normalizedInstruction = userInstruction || "(no instruction provided)";
  const isPdfRegion = element.tag === "pdf-region";

  const closingLine = isPdfRegion
    ? intent === "fix"
      ? "The attached screenshot is tightly cropped to the selected PDF region. Focus on that selected region first and make the appropriate code or content change only if the user asked for one. Only use broader document context when it materially helps answer the user's question."
      : intent === "context"
        ? "The attached screenshot is tightly cropped to the selected PDF region. Focus on that selected region first when responding. Only use broader document context when it materially helps answer the user's question."
        : "The attached screenshot is tightly cropped to the selected PDF region. Focus your answer on that selected region first. Only use broader document context when it materially helps answer the user's question."
    : intent === "fix"
      ? "Use the attached screenshot and selected element metadata to make the appropriate code change."
      : intent === "context"
        ? "Refer to the attached screenshot and selected element metadata when responding."
        : undefined;

  const lines = [
    "Browser annotation",
    "",
    "User instruction:",
    normalizedInstruction,
    "",
    "Page:",
    `Title: ${page.title}`,
    `URL: ${page.url}`,
    `Viewport: width=${viewport.width} height=${viewport.height} devicePixelRatio=${viewport.devicePixelRatio}`,
    "",
    "Selected element:",
    `Selector: ${element.selector}`,
    `Tag: ${element.tag}`,
    `Role: ${element.role}`,
    `Text: ${element.text}`,
    `Aria label: ${element.ariaLabel ?? ""}`,
    `Rect: x=${rect.x} y=${rect.y} width=${rect.width} height=${rect.height}`,
  ];

  if (closingLine) {
    lines.push("", closingLine);
  }

  return lines.join("\n");
}

export function appendAnnotationsToPrompt(
  prompt: string,
  annotations: ReadonlyArray<ComposerAnnotationAttachment>,
): string {
  if (annotations.length === 0) {
    return prompt;
  }
  const annotationText = annotations
    .map((annotation) => buildBrowserAnnotationPrompt(annotation))
    .join("\n\n---\n\n");
  const trimmedPrompt = prompt.trimEnd();
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${annotationText}` : annotationText;
}

export const appendBrowserAnnotationsToPrompt = appendAnnotationsToPrompt;
