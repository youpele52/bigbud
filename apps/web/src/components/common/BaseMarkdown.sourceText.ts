interface SourcePoint {
  readonly line: number;
  readonly column?: number;
  readonly offset?: number;
}

export interface MarkdownSourceNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  children?: MarkdownSourceNode[];
  readonly position?: { readonly start: SourcePoint; readonly end: SourcePoint };
  properties?: Record<string, unknown>;
}

function mappedLine(line: number, lineMap: ReadonlyArray<number>): number | null {
  const mapped = lineMap[line];
  return mapped && Number.isInteger(mapped) && mapped > 0 ? mapped : null;
}

function sourceTextSpan(value: string, line: number | null): MarkdownSourceNode {
  return {
    type: "element",
    tagName: "span",
    properties: line === null ? {} : { "data-source-text-line": line },
    children: [{ type: "text", value }],
  };
}

function inlineCodeSpans(
  node: MarkdownSourceNode,
  source: string,
  lineMap: ReadonlyArray<number>,
): MarkdownSourceNode[] | null {
  const position = node.position;
  if (position?.start.offset === undefined || position.end.offset === undefined) return null;
  const raw = source.slice(position.start.offset, position.end.offset).replace(/^`+|`+$/g, "");
  const sourceLines = raw.split(/\r\n|\r|\n/);
  const pieces = sourceLines.map(
    (piece, index) => piece + (index < sourceLines.length - 1 ? " " : ""),
  );
  const normalized = pieces.join("");
  // CommonMark normalizes inline-code newlines to spaces and strips one
  // boundary space when both ends have one (unless the value is all spaces).
  if (normalized.startsWith(" ") && normalized.endsWith(" ") && /[^ ]/.test(normalized)) {
    pieces[0] = pieces[0]!.slice(1);
    const last = pieces.findLastIndex((piece) => piece.length > 0);
    pieces[last] = pieces[last]!.slice(0, -1);
  }
  if (pieces.join("") !== node.children?.map((child) => child.value ?? "").join("")) {
    return null;
  }
  return pieces.map((piece, index) =>
    sourceTextSpan(piece, mappedLine(position.start.line + index, lineMap)),
  );
}

/** Add selection-only text metadata without changing block layout or scroll anchors. */
export function addSourceTextPositions(
  node: MarkdownSourceNode,
  lineMap: ReadonlyArray<number>,
  source: string,
  sourceLines: ReadonlyArray<string> = source.split("\n"),
): void {
  if (node.tagName === "pre") {
    const start = node.position?.start;
    if (!start) return;
    const opening = sourceLines[start.line - 1]?.slice((start.column ?? 1) - 1) ?? "";
    const firstLine = start.line + (/^(`{3,}|~{3,})/.test(opening) ? 1 : 0);
    const code = node.children?.[0]?.children?.map((child) => child.value ?? "").join("") ?? "";
    node.properties = {
      ...node.properties,
      "data-source-code-lines": JSON.stringify(
        code.split("\n").map((_line, index) => mappedLine(firstLine + index, lineMap)),
      ),
    };
    return;
  }
  if (node.tagName === "code") {
    const spans = inlineCodeSpans(node, source, lineMap);
    if (spans) {
      node.children = spans;
      return;
    }
  }
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.position && child.value) {
      const position = child.position;
      const pieces = child.value.split("\n");
      return pieces.map((piece, index) =>
        sourceTextSpan(
          piece + (index < pieces.length - 1 ? "\n" : ""),
          mappedLine(Math.min(position.start.line + index, position.end.line), lineMap),
        ),
      );
    }
    addSourceTextPositions(child, lineMap, source, sourceLines);
    return [child];
  });
}
