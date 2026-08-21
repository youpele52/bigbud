import "../../index.css";

import type { ContextMenuItem, NativeApi } from "@bigbud/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { useMemo, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../rpc/nativeApi";
import type { PendingDiffAnnotation } from "./DiffPanel.annotations";
import { useDiffAnnotateContextMenu } from "./useDiffAnnotateContextMenu";

const FILE_PATH = "src/example.ts";
const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 0000000..1111111 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,4 +1,3 @@",
  " const existing = true;",
  "-const obsolete = true;",
  "-const removed = true;",
  "+const added = true;",
  " const after = true;",
].join("\n");

function DiffAnnotationHarness({
  fileDiff,
  onAnnotateRequest = () => {},
}: {
  readonly fileDiff: FileDiffMetadata;
  readonly onAnnotateRequest?: (annotation: PendingDiffAnnotation) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pierreLineSelectionsRef = useRef(new Map());
  const fileDiffByPath = useMemo(() => new Map([[FILE_PATH, fileDiff]]), [fileDiff]);

  useDiffAnnotateContextMenu({
    viewportRef,
    canAnnotate: true,
    cwd: "/repo",
    fileDiffByPath,
    pierreLineSelectionsRef,
    onAnnotateRequest,
  });

  return (
    <div ref={viewportRef} data-testid="viewport">
      <div data-diff-file-path={FILE_PATH}>
        <FileDiff
          fileDiff={fileDiff}
          disableWorkerPool
          options={{
            diffStyle: "unified",
            lineDiffType: "none",
            enableLineSelection: true,
          }}
        />
      </div>
    </div>
  );
}

function selectText(
  element: Element,
  text: string,
): { readonly selection: Selection; readonly target: Node } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node as Text);
  }

  const fullText = textNodes.map((node) => node.data).join("");
  const selectionStart = fullText.indexOf(text);
  const selectionEnd = selectionStart + text.length;
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of textNodes) {
    const nextOffset = offset + node.length;
    if (!startNode && selectionStart >= offset && selectionStart <= nextOffset) {
      startNode = node;
      startOffset = selectionStart - offset;
    }
    if (selectionEnd >= offset && selectionEnd <= nextOffset) {
      endNode = node;
      endOffset = selectionEnd - offset;
      break;
    }
    offset = nextOffset;
  }

  expect(startNode).not.toBeNull();
  expect(endNode).not.toBeNull();
  const range = document.createRange();
  range.setStart(startNode!, startOffset);
  range.setEnd(endNode!, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return { selection, target: endNode!.parentNode! };
}

function firstTextNode(element: Element): Text | null {
  return document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text | null;
}

describe("DiffPanel native text annotation", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    delete window.nativeApi;
    __resetNativeApiForTests();
  });

  it("offers annotation for native text selected inside a Pierre addition", async () => {
    const showContextMenu = vi.fn<NativeApi["contextMenu"]["show"]>().mockResolvedValue(null);
    window.nativeApi = { contextMenu: { show: showContextMenu } } as unknown as NativeApi;
    __resetNativeApiForTests();

    const fileDiff = parsePatchFiles(PATCH, "native-selection-regression")[0]?.files[0];
    expect(fileDiff).toBeDefined();
    await render(<DiffAnnotationHarness fileDiff={fileDiff!} />);

    let additionLine: HTMLElement | null = null;
    let followingLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      const container = document.querySelector("diffs-container");
      const renderedLines = Array.from(
        container?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
      );
      additionLine =
        renderedLines.find((line) => line.textContent?.includes("const added")) ?? null;
      followingLine =
        renderedLines.find((line) => line.textContent?.includes("const after")) ?? null;
      expect(additionLine).not.toBeNull();
      expect(followingLine).not.toBeNull();
    });
    expect(additionLine!.dataset.lineType).toBe("change-addition");
    expect(followingLine!.dataset.lineType).toBe("context");

    const selectedCode = "const added = true;";
    const { selection } = selectText(additionLine!, selectedCode);
    const followingText = firstTextNode(followingLine!);
    expect(followingText).not.toBeNull();
    selection.getRangeAt(0).setEnd(followingText!, 0);
    expect(selection.toString().trim()).toBe(selectedCode);
    expect(selection.getRangeAt(0).startContainer.getRootNode()).toBeInstanceOf(ShadowRoot);
    expect(selection.getRangeAt(0).endContainer).toBe(followingText);
    expect(selection.getRangeAt(0).endOffset).toBe(0);

    additionLine!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        clientX: 40,
        clientY: 60,
      }),
    );

    await vi.waitFor(() => expect(showContextMenu).toHaveBeenCalledOnce());
    const items = showContextMenu.mock.calls[0]![0] as ReadonlyArray<ContextMenuItem>;
    expect(items.map((item) => item.label)).toContain("Annotate selection");
  });

  it("preserves partial native text across deletion and addition rows", async () => {
    const showContextMenu = vi
      .fn<NativeApi["contextMenu"]["show"]>()
      .mockResolvedValue("annotate-selection");
    window.nativeApi = { contextMenu: { show: showContextMenu } } as unknown as NativeApi;
    __resetNativeApiForTests();
    const onAnnotateRequest = vi.fn();

    const fileDiff = parsePatchFiles(PATCH, "mixed-native-selection")[0]?.files[0];
    expect(fileDiff).toBeDefined();
    await render(
      <DiffAnnotationHarness fileDiff={fileDiff!} onAnnotateRequest={onAnnotateRequest} />,
    );

    let deletionLine: HTMLElement | null = null;
    let additionLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      const renderedLines = Array.from(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
      );
      deletionLine =
        renderedLines.find((line) => line.textContent?.includes("const removed")) ?? null;
      additionLine =
        renderedLines.find((line) => line.textContent?.includes("const added")) ?? null;
      expect(deletionLine).not.toBeNull();
      expect(additionLine).not.toBeNull();
    });

    const { selection } = selectText(deletionLine!, "removed = true;");
    const range = selection.getRangeAt(0);
    const deletionStartNode = range.startContainer;
    const deletionStartOffset = range.startOffset;
    selectText(additionLine!, "const added");
    const additionRange = selection.getRangeAt(0);
    additionRange.setStart(deletionStartNode, deletionStartOffset);
    expect(selection.toString()).toContain("removed = true;");
    expect(selection.toString()).toContain("const added");

    additionLine!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        clientX: 40,
        clientY: 60,
      }),
    );

    await vi.waitFor(() => expect(showContextMenu).toHaveBeenCalledOnce());
    const items = showContextMenu.mock.calls[0]![0] as ReadonlyArray<ContextMenuItem>;
    expect(items.map((item) => item.label)).toContain("Annotate selection");
    await vi.waitFor(() => expect(onAnnotateRequest).toHaveBeenCalledOnce());
    const expectedDiffText = ["--- before", "+++ after", "-removed = true;", "+const added"].join(
      "\n",
    );
    expect(onAnnotateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: FILE_PATH,
        range: { startLine: 2, endLine: 3 },
        selectedText: expectedDiffText,
      }),
    );
  });

  it("serializes a context-only native selection as unified diff context", async () => {
    const showContextMenu = vi
      .fn<NativeApi["contextMenu"]["show"]>()
      .mockResolvedValue("annotate-selection");
    window.nativeApi = { contextMenu: { show: showContextMenu } } as unknown as NativeApi;
    __resetNativeApiForTests();
    const onAnnotateRequest = vi.fn();
    const fileDiff = parsePatchFiles(PATCH, "context-native-selection")[0]?.files[0];
    await render(
      <DiffAnnotationHarness fileDiff={fileDiff!} onAnnotateRequest={onAnnotateRequest} />,
    );

    let contextLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      contextLine =
        Array.from(
          document
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
        ).find((line) => line.textContent?.includes("const after")) ?? null;
      expect(contextLine).not.toBeNull();
    });

    selectText(contextLine!, "const after = true;");
    contextLine!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, composed: true, clientX: 40, clientY: 60 }),
    );

    await vi.waitFor(() => expect(onAnnotateRequest).toHaveBeenCalledOnce());
    expect(onAnnotateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedText: ["--- before", "+++ after", " const after = true;"].join("\n"),
      }),
    );
  });

  it("keeps annotation available when right click clears the native selection", async () => {
    const showContextMenu = vi
      .fn<NativeApi["contextMenu"]["show"]>()
      .mockResolvedValue("annotate-selection");
    window.nativeApi = { contextMenu: { show: showContextMenu } } as unknown as NativeApi;
    __resetNativeApiForTests();
    const onAnnotateRequest = vi.fn();

    const fileDiff = parsePatchFiles(PATCH, "cleared-native-selection")[0]?.files[0];
    expect(fileDiff).toBeDefined();
    await render(
      <DiffAnnotationHarness fileDiff={fileDiff!} onAnnotateRequest={onAnnotateRequest} />,
    );

    let additionLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      additionLine =
        Array.from(
          document
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
        ).find((line) => line.textContent?.includes("const added")) ?? null;
      expect(additionLine).not.toBeNull();
    });

    const selectedCode = "const added = true;";
    selectText(additionLine!, selectedCode);
    additionLine!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, composed: true, button: 2 }),
    );
    window.getSelection()!.removeAllRanges();

    additionLine!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        clientX: 40,
        clientY: 60,
      }),
    );

    await vi.waitFor(() => expect(showContextMenu).toHaveBeenCalledOnce());
    const items = showContextMenu.mock.calls[0]![0] as ReadonlyArray<ContextMenuItem>;
    expect(items.map((item) => item.label)).toContain("Copy");
    expect(items.map((item) => item.label)).toContain("Annotate selection");
    await vi.waitFor(() => expect(onAnnotateRequest).toHaveBeenCalledOnce());
    expect(onAnnotateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: FILE_PATH,
        range: { startLine: 2, endLine: 2 },
        selectedText: ["--- before", "+++ after", `+${selectedCode}`].join("\n"),
      }),
    );
  });
});
