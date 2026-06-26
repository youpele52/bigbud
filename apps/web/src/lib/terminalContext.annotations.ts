export interface ParsedBrowserAnnotationEntry {
  kind: "browser";
  text: string;
  comment: string;
  pageTitle: string;
  pageUrl: string;
  selector: string;
  tag: string;
}

export interface ParsedCodeAnnotationEntry {
  kind: "code";
  text: string;
  comment: string;
  projectName: string;
  workspace: string;
  path: string;
  lineLabel: string;
  selectedCode: string;
}

export interface ParsedTerminalAnnotationEntry {
  kind: "terminal";
  text: string;
  comment: string;
  terminalLabel: string;
  terminalId: string;
  lineLabel: string;
  selectedOutput: string;
}

export type ParsedUserAnnotationEntry =
  | ParsedBrowserAnnotationEntry
  | ParsedCodeAnnotationEntry
  | ParsedTerminalAnnotationEntry;

const ANNOTATION_SEPARATOR = "\n\n---\n\n";
const BROWSER_ANNOTATION_HEADER = "Browser annotation\n\nUser instruction:\n";
const CODE_ANNOTATION_HEADER = "Code annotation\n\nUser instruction:\n";
const TERMINAL_ANNOTATION_HEADER = "Terminal annotation\n\nUser instruction:\n";
const BROWSER_ANNOTATION_PAGE_MARKER = "\n\nPage:\n";
const BROWSER_ANNOTATION_ELEMENT_MARKER = "\n\nSelected element:\n";
const CODE_ANNOTATION_FILE_MARKER = "\n\nFile:\n";
const CODE_ANNOTATION_SELECTION_MARKER = "\n\nSelected code:\n```\n";
const TERMINAL_ANNOTATION_TERMINAL_MARKER = "\n\nTerminal:\n";
const TERMINAL_ANNOTATION_SELECTION_MARKER = "\n\nSelected output:\n```\n";

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
    kind: "browser",
    text,
    comment,
    pageTitle: readAnnotationField(lines, "Title: "),
    pageUrl: readAnnotationField(lines, "URL: "),
    selector: readAnnotationField(lines, "Selector: "),
    tag: readAnnotationField(lines, "Tag: "),
  };
}

function parseCodeAnnotationEntry(text: string): ParsedCodeAnnotationEntry {
  const lines = text.split("\n");
  const userInstructionIndex = lines.indexOf("User instruction:");
  const fileIndex = lines.indexOf("File:");
  const comment =
    userInstructionIndex >= 0 && fileIndex > userInstructionIndex
      ? lines
          .slice(userInstructionIndex + 1, fileIndex)
          .join("\n")
          .trim()
      : "";
  const selectedCodeMatch = /Selected code:\n```\n([\s\S]*?)\n```/.exec(text);

  const singleLine = readAnnotationField(lines, "Line: ");
  const multiLine = readAnnotationField(lines, "Lines: ");

  return {
    kind: "code",
    text,
    comment,
    projectName: readAnnotationField(lines, "Project: "),
    workspace: readAnnotationField(lines, "Workspace: "),
    path: readAnnotationField(lines, "Path: "),
    lineLabel: singleLine ? `Line ${singleLine}` : multiLine ? `Lines ${multiLine}` : "",
    selectedCode: selectedCodeMatch?.[1] ?? "",
  };
}

function parseTerminalAnnotationEntry(text: string): ParsedTerminalAnnotationEntry {
  const lines = text.split("\n");
  const userInstructionIndex = lines.indexOf("User instruction:");
  const terminalIndex = lines.indexOf("Terminal:");
  const comment =
    userInstructionIndex >= 0 && terminalIndex > userInstructionIndex
      ? lines
          .slice(userInstructionIndex + 1, terminalIndex)
          .join("\n")
          .trim()
      : "";
  const selectedOutputMatch = /Selected output:\n```\n([\s\S]*?)\n```/.exec(text);

  const singleLine = readAnnotationField(lines, "Line: ");
  const multiLine = readAnnotationField(lines, "Lines: ");

  return {
    kind: "terminal",
    text,
    comment,
    terminalLabel: readAnnotationField(lines, "Label: "),
    terminalId: readAnnotationField(lines, "ID: "),
    lineLabel: singleLine ? `Line ${singleLine}` : multiLine ? `Lines ${multiLine}` : "",
    selectedOutput: selectedOutputMatch?.[1] ?? "",
  };
}

function isBrowserAnnotationBlock(text: string): boolean {
  return (
    text.startsWith(BROWSER_ANNOTATION_HEADER) &&
    text.includes(BROWSER_ANNOTATION_PAGE_MARKER) &&
    text.includes(BROWSER_ANNOTATION_ELEMENT_MARKER)
  );
}

function isCodeAnnotationBlock(text: string): boolean {
  return (
    text.startsWith(CODE_ANNOTATION_HEADER) &&
    text.includes(CODE_ANNOTATION_FILE_MARKER) &&
    text.includes(CODE_ANNOTATION_SELECTION_MARKER) &&
    text.includes("\n```")
  );
}

function isTerminalAnnotationBlock(text: string): boolean {
  return (
    text.startsWith(TERMINAL_ANNOTATION_HEADER) &&
    text.includes(TERMINAL_ANNOTATION_TERMINAL_MARKER) &&
    text.includes(TERMINAL_ANNOTATION_SELECTION_MARKER) &&
    text.includes("\n```")
  );
}

function parseAnnotationEntry(text: string): ParsedUserAnnotationEntry | null {
  if (isBrowserAnnotationBlock(text)) {
    return parseBrowserAnnotationEntry(text);
  }
  if (isCodeAnnotationBlock(text)) {
    return parseCodeAnnotationEntry(text);
  }
  if (isTerminalAnnotationBlock(text)) {
    return parseTerminalAnnotationEntry(text);
  }
  return null;
}

function findAnnotationStartIndexes(prompt: string): number[] {
  const starts = new Set<number>();
  let browserIndex = prompt.indexOf(BROWSER_ANNOTATION_HEADER);
  while (browserIndex !== -1) {
    starts.add(browserIndex);
    browserIndex = prompt.indexOf(BROWSER_ANNOTATION_HEADER, browserIndex + 1);
  }
  let codeIndex = prompt.indexOf(CODE_ANNOTATION_HEADER);
  while (codeIndex !== -1) {
    starts.add(codeIndex);
    codeIndex = prompt.indexOf(CODE_ANNOTATION_HEADER, codeIndex + 1);
  }
  let terminalIndex = prompt.indexOf(TERMINAL_ANNOTATION_HEADER);
  while (terminalIndex !== -1) {
    starts.add(terminalIndex);
    terminalIndex = prompt.indexOf(TERMINAL_ANNOTATION_HEADER, terminalIndex + 1);
  }
  return [...starts].toSorted((left, right) => left - right);
}

export function extractTrailingAnnotations(prompt: string): {
  promptText: string;
  annotations: ParsedUserAnnotationEntry[];
} {
  const normalizedPrompt = prompt.replace(/\s+$/, "");

  for (const annotationStartIndex of findAnnotationStartIndexes(normalizedPrompt)) {
    const suffix = normalizedPrompt.slice(annotationStartIndex);
    const annotations = suffix
      .split(ANNOTATION_SEPARATOR)
      .map((part) => parseAnnotationEntry(part))
      .filter((entry): entry is ParsedUserAnnotationEntry => entry !== null);

    if (annotations.length === 0) {
      continue;
    }

    if (annotations.length === suffix.split(ANNOTATION_SEPARATOR).length) {
      return {
        promptText: normalizedPrompt.slice(0, annotationStartIndex).replace(/\n+$/, ""),
        annotations,
      };
    }
  }

  return {
    promptText: prompt,
    annotations: [],
  };
}
