export interface ParsedBrowserAnnotationEntry {
  text: string;
  comment: string;
  pageTitle: string;
  pageUrl: string;
  selector: string;
  tag: string;
}

const BROWSER_ANNOTATION_HEADER = "Browser annotation\n\nUser instruction:\n";
const BROWSER_ANNOTATION_FOOTER =
  "Use the attached screenshot and selected element metadata to make the appropriate code change.";
const BROWSER_ANNOTATION_SEPARATOR = "\n\n---\n\n";

function isBrowserAnnotationBlock(text: string): boolean {
  return text.startsWith(BROWSER_ANNOTATION_HEADER) && text.endsWith(BROWSER_ANNOTATION_FOOTER);
}

function readAnnotationField(lines: ReadonlyArray<string>, prefix: string): string {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

function parseBrowserAnnotationEntry(text: string): ParsedBrowserAnnotationEntry {
  const lines = text.split("\n");
  const userInstructionIndex = lines.indexOf("User instruction:");
  const pageIndex = lines.indexOf("Page:");
  const comment =
    userInstructionIndex >= 0 && pageIndex > userInstructionIndex
      ? lines
          .slice(userInstructionIndex + 1, pageIndex)
          .join("\n")
          .trim()
      : "";

  return {
    text,
    comment,
    pageTitle: readAnnotationField(lines, "Title: "),
    pageUrl: readAnnotationField(lines, "URL: "),
    selector: readAnnotationField(lines, "Selector: "),
    tag: readAnnotationField(lines, "Tag: "),
  };
}

export function extractTrailingBrowserAnnotations(prompt: string): {
  promptText: string;
  annotations: ParsedBrowserAnnotationEntry[];
} {
  const normalizedPrompt = prompt.replace(/\s+$/, "");
  if (!normalizedPrompt.endsWith(BROWSER_ANNOTATION_FOOTER)) {
    return { promptText: prompt, annotations: [] };
  }

  let annotationStartIndex = normalizedPrompt.indexOf(BROWSER_ANNOTATION_HEADER);
  while (annotationStartIndex !== -1) {
    const suffix = normalizedPrompt.slice(annotationStartIndex);
    const parts = suffix.split(BROWSER_ANNOTATION_SEPARATOR);
    if (parts.every(isBrowserAnnotationBlock)) {
      const promptText = normalizedPrompt.slice(0, annotationStartIndex);
      return {
        promptText: promptText.replace(/\n+$/, ""),
        annotations: parts.map(parseBrowserAnnotationEntry),
      };
    }

    annotationStartIndex = normalizedPrompt.indexOf(
      BROWSER_ANNOTATION_HEADER,
      annotationStartIndex + BROWSER_ANNOTATION_HEADER.length,
    );
  }

  return {
    promptText: prompt,
    annotations: [],
  };
}
