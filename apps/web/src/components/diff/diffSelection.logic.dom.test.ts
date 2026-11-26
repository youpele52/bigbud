import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import { resolveDiffSelectionFromDom } from "./diffSelection.logic";
import { mockElement } from "./diffSelection.logic.test.helpers";

describe("resolveDiffSelectionFromDom", () => {
  it("resolves mixed deletion and addition rows from a DOM selection", () => {
    const fileContainer = mockElement({
      dataset: { diffFilePath: "apps/web/src/App.tsx" },
    });
    const startLine = mockElement({
      attributes: { "data-line": "12", "data-line-type": "change-deletion" },
      parent: fileContainer,
      textContent: "const value = 1;\n",
    });
    const endLine = mockElement({
      attributes: { "data-line": "10", "data-line-type": "change-addition" },
      parent: fileContainer,
      textContent: "return value;\n",
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: startLine,
        endContainer: endLine,
      }),
      anchorNode: startLine,
      focusNode: endLine,
      toString: () => "const value = 1;\nreturn value;",
    } as unknown as Selection;

    expect(resolveDiffSelectionFromDom(selection)).toEqual({
      filePath: "apps/web/src/App.tsx",
      range: { startLine: 10, endLine: 10 },
      selectedText: [
        "Diff annotation (both states)",
        "",
        "Before (old line 12):",
        "-const value = 1;",
        "",
        "After (new line 10):",
        "+return value;",
      ].join("\n"),
    });
  });

  it("anchors deletion-only DOM selections to the new-state position", () => {
    const filePath = "src/example.ts";
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -5,3 +5,2 @@",
      " const context = true;",
      "-  removed();",
      " const after = true;",
    ].join("\n");
    const fileDiff = parsePatchFiles(patch, "deletion-only-dom-selection")[0]!.files[0]!;
    const fileContainer = mockElement({ dataset: { diffFilePath: filePath } });
    const line = mockElement({
      attributes: { "data-line": "6", "data-line-type": "change-deletion" },
      parent: fileContainer,
      textContent: "  removed();\n",
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: line, endContainer: line }),
      anchorNode: line,
      focusNode: line,
      toString: () => "  removed();\n",
    } as unknown as Selection;

    expect(resolveDiffSelectionFromDom(selection, { fileDiff })).toEqual({
      filePath,
      range: { startLine: 5, endLine: 5 },
      selectedText: [
        "Diff annotation (before only)",
        "",
        "Before (old line 6):",
        "-  removed();",
        "",
        "After (new state unchanged at new line 5):",
        "(no added lines: this change block only deletes old code)",
      ].join("\n"),
    });
  });

  it("resolves a Chromium-retargeted shadow selection from its shadow rows", () => {
    const filePath = "src/example.ts";
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -30,3 +30,4 @@",
      "-const active = useRef(null);",
      "-if (!active.current) {",
      "-  active.current = {",
      "+const [active, setActive] = useState(() => ({",
      "+  session: session ? { ...session } : null,",
      "+  generation: 1,",
      "+}));",
    ].join("\n");
    const fileDiff = parsePatchFiles(patch, "retargeted-shadow")[0]!.files[0]!;
    const fileContainer = mockElement({ dataset: { diffFilePath: filePath } });
    const lines = [
      mockElement({
        attributes: { "data-line": "30", "data-line-type": "change-deletion" },
        parent: fileContainer,
        textContent: "const active = useRef(null);",
      }),
      mockElement({
        attributes: { "data-line": "31", "data-line-type": "change-deletion" },
        parent: fileContainer,
        textContent: "if (!active.current) {",
      }),
      mockElement({
        attributes: { "data-line": "32", "data-line-type": "change-deletion" },
        parent: fileContainer,
        textContent: "  active.current = {",
      }),
      mockElement({
        attributes: { "data-line": "30", "data-line-type": "change-addition" },
        parent: fileContainer,
        textContent: "const [active, setActive] = useState(() => ({",
      }),
      mockElement({
        attributes: { "data-line": "33", "data-line-type": "change-addition" },
        parent: fileContainer,
        textContent: "}));",
      }),
    ];
    const shadowRoot = {
      querySelectorAll: () => lines,
    } as unknown as ShadowRoot;
    const diffHost = {
      ...mockElement({}),
      shadowRoot,
    } as HTMLElement;
    const selectedLines = new Set<HTMLElement>([
      lines[0]!,
      lines[1]!,
      lines[2]!,
      lines[3]!,
      lines[4]!,
    ]);
    const selectedText = [
      "tive = useRef(null);",
      "if (!active.current) {",
      "  active.current = {",
      "const [active, setActive] = useState(() => ({",
      "}));",
    ].join("\n");
    // Chromium reports a real shadow-root drag as collapsed with a document-level
    // Range, while toString() and containsNode() still describe the shadow rows.
    const selection = {
      isCollapsed: true,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: fileContainer, endContainer: fileContainer }),
      anchorNode: fileContainer,
      focusNode: fileContainer,
      toString: () => selectedText,
      containsNode: (node: Node) => selectedLines.has(node as HTMLElement),
    } as unknown as Selection;

    expect(
      resolveDiffSelectionFromDom(selection, {
        event: { composedPath: () => [lines[0], diffHost] } as unknown as MouseEvent,
        fileDiff,
      }),
    ).toEqual({
      filePath,
      range: { startLine: 30, endLine: 33 },
      selectedText: [
        "Diff annotation (both states)",
        "",
        "Before (old lines 30-32):",
        "-const active = useRef(null);",
        "-if (!active.current) {",
        "-  active.current = {",
        "",
        "After (new lines 30-33):",
        "+const [active, setActive] = useState(() => ({",
        "+  session: session ? { ...session } : null,",
        "+  generation: 1,",
        "+}));",
      ].join("\n"),
    });
  });
});
