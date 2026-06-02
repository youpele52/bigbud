import {
  isCodeAnnotationAttachment,
  type ComposerAnnotationAttachment,
} from "../../../stores/composer";
import type { ComposerCodeAnnotationAttachment } from "../../../stores/composer/types.annotation.store";

export function buildCodeAnnotationPrompt(annotation: ComposerCodeAnnotationAttachment): string {
  const userInstruction = annotation.comment.trim() || "(no instruction provided)";
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
    userInstruction,
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
  const { element, page, viewport, intent } = annotation;
  const rect = element.rect;
  const userInstruction = annotation.comment.trim() || "(no instruction provided)";

  const closingLine =
    intent === "fix"
      ? "Use the attached screenshot and selected element metadata to make the appropriate code change."
      : intent === "context"
        ? "Refer to the attached screenshot and selected element metadata when responding."
        : undefined;

  const lines = [
    "Browser annotation",
    "",
    "User instruction:",
    userInstruction,
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
