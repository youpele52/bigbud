const SOURCE_POSITION_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

interface SourcePositionNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<SourcePositionNode>;
  readonly position?: {
    readonly start?: { readonly line?: number };
    readonly end?: { readonly line?: number };
  };
  properties?: Record<string, unknown>;
}

export function isMarkdownSourceBlock(tagName: string): boolean {
  return tagName !== "img" && SOURCE_POSITION_TAGS.has(tagName);
}

function resolveSourceLine(line: number, lineMap: ReadonlyArray<number>): number | null {
  const sourceLine = lineMap[line];
  return typeof sourceLine === "number" && Number.isInteger(sourceLine) && sourceLine > 0
    ? sourceLine
    : null;
}

function ownTextSegments(node: SourcePositionNode, lineMap: ReadonlyArray<number>): string | null {
  if (!node.children?.some((child) => child.tagName && isMarkdownSourceBlock(child.tagName))) {
    return null;
  }
  const segments: Array<readonly [number, number] | null> = [];
  let hasContent = false;
  let startLine: number | null = null;
  let endLine: number | null = null;
  const finishSegment = () => {
    if (hasContent) {
      segments.push(startLine !== null && endLine !== null ? [startLine, endLine] : null);
    }
    hasContent = false;
    startLine = null;
    endLine = null;
  };
  for (const child of node.children) {
    if (child.tagName && isMarkdownSourceBlock(child.tagName)) {
      finishSegment();
    } else if (child.type !== "text" || child.value?.trim()) {
      hasContent = true;
      const start = resolveSourceLine(child.position?.start?.line ?? 0, lineMap);
      const end = resolveSourceLine(child.position?.end?.line ?? 0, lineMap);
      startLine ??= start;
      if (end !== null) endLine = end;
    }
  }
  finishSegment();
  return segments.length > 0 ? JSON.stringify(segments) : null;
}

function addSourcePosition(node: SourcePositionNode, lineMap: ReadonlyArray<number>): void {
  if (
    node.type === "element" &&
    node.tagName &&
    SOURCE_POSITION_TAGS.has(node.tagName) &&
    node.position?.start?.line &&
    node.position.end?.line
  ) {
    const startLine = resolveSourceLine(node.position.start.line, lineMap);
    const endLine = resolveSourceLine(node.position.end.line, lineMap);
    if (startLine !== null && endLine !== null) {
      const start = Math.min(startLine, endLine);
      const end = Math.max(startLine, endLine);
      node.properties = {
        ...node.properties,
        "data-source-start-line": start,
        "data-source-end-line": end,
      };
      // Tight lists unwrap paragraphs into inline children. Keep their own source
      // ranges separate from nested lists without inserting layout wrappers.
      const segments = ownTextSegments(node, lineMap);
      if (segments !== null) node.properties["data-source-text-segments"] = segments;
    }
  }

  for (const child of node.children ?? []) {
    addSourcePosition(child, lineMap);
  }
}

export function createSourcePositionPlugin(lineMap: ReadonlyArray<number>) {
  return () =>
    (tree: unknown): void => {
      addSourcePosition(tree as SourcePositionNode, lineMap);
    };
}

export function sourcePositionProps(props: Record<string, unknown>): Record<string, number> {
  const startLine = props["data-source-start-line"];
  const endLine = props["data-source-end-line"];
  if (
    typeof startLine !== "number" ||
    !Number.isFinite(startLine) ||
    typeof endLine !== "number" ||
    !Number.isFinite(endLine)
  ) {
    return {};
  }
  return {
    "data-source-start-line": startLine,
    "data-source-end-line": endLine,
  };
}
