import "../../index.css";

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { FilePreviewCode } from "./FilePreview.code";

const CONTENTS = "alpha\nbeta value\ngamma";

function renderCodePreview(
  onSelectRange = vi.fn(),
  onSelectLine = vi.fn(),
  selectedRange: { startLine: number; endLine: number } | null = null,
  code: { contents: string; language: string; isPlainTextFile: boolean } = {
    contents: CONTENTS,
    language: "text",
    isPlainTextFile: true,
  },
) {
  return render(
    <FilePreviewCode
      contents={code.contents}
      language={code.language}
      themeName="pierre-dark"
      isPlainTextFile={code.isPlainTextFile}
      truncated={false}
      selectedRange={selectedRange}
      selectedText={selectedRange ? "alpha\nbeta value" : ""}
      scrollContainerRef={createRef<HTMLDivElement>()}
      linesContainerRef={createRef<HTMLDivElement>()}
      codeContainerRef={createRef<HTMLDivElement>()}
      onScroll={() => {}}
      onContextMenu={() => {}}
      onSelectRange={onSelectRange}
      onSelectLine={onSelectLine}
      onCreateAnnotation={() => {}}
      onCancelAnnotation={() => {}}
    />,
  );
}

describe("FilePreviewCode annotation affordances", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("shows the shared trigger for the hovered visual line and opens it on click", async () => {
    const onSelectLine = vi.fn();
    await renderCodePreview(vi.fn(), onSelectLine);
    const lines = document.querySelector<HTMLElement>(".file-preview-code")!.parentElement!;
    const bounds = lines.getBoundingClientRect();

    lines.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: bounds.right - 4,
        clientY: bounds.top + 25,
      }),
    );

    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Annotate line 2"]')!;
    await vi.waitFor(() =>
      expect(trigger.querySelector("svg")?.classList.contains("block")).toBe(true),
    );
    expect(trigger.querySelector("svg")?.classList.contains("size-8")).toBe(true);
    trigger.click();
    expect(onSelectLine).toHaveBeenCalledWith(2, false);

    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectLine).toHaveBeenLastCalledWith(2, true);
  });

  it("keeps the 32px pointer blue only on the highest selected line", async () => {
    await renderCodePreview(vi.fn(), vi.fn(), { startLine: 1, endLine: 2 });

    const first = document.querySelector<HTMLButtonElement>('[aria-label="Annotate line 1"]')!;
    const second = document.querySelector<HTMLButtonElement>('[aria-label="Annotate line 2"]')!;
    expect(first.classList.contains("text-info")).toBe(false);
    expect(first.querySelector("svg")).toBeNull();
    expect(second.classList.contains("text-info")).toBe(true);
    expect(second.querySelector("svg")?.classList.contains("size-8")).toBe(true);
    expect(second.querySelector("svg")?.classList.contains("block")).toBe(true);
  });

  it("opens a multi-line text selection only at the existing two-character threshold", async () => {
    const onSelectRange = vi.fn();
    await renderCodePreview(onSelectRange);
    const code = document.querySelector<HTMLElement>(".file-preview-code")!;
    const text = code.querySelector("pre")!.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 18);
    selection.addRange(range);

    code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(onSelectRange).toHaveBeenCalledWith({ startLine: 2, endLine: 3 });

    onSelectRange.mockClear();
    selection.removeAllRanges();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    selection.addRange(range);
    code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(onSelectRange).not.toHaveBeenCalled();
  });

  it("renders environment keys and values with syntax colors", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await renderCodePreview(vi.fn(), vi.fn(), null, {
      contents: "EXTEND_ESLINT=true\nAPI_URL=http://localhost/api\n# Local settings",
      language: "dotenv",
      isPlainTextFile: false,
    });

    await expect.poll(() => document.querySelector(".chat-markdown-shiki")).not.toBeNull();
    expect(
      document.querySelectorAll(".chat-markdown-shiki span[style*='color']").length,
    ).toBeGreaterThan(1);
  });
});
