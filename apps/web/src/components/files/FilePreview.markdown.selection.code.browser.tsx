import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { sourcePositionProps } from "../common/BaseMarkdown.sourcePositions";
import { resolveMarkdownPreviewTextSelection } from "./FilePreview.markdown.selection";
import {
  afterPreviewText,
  previewTextPoint,
  selectPreviewText,
} from "./FilePreview.markdown.selection.browser.utils";

// Match MarkdownCodeBlock + Shiki's DOM contract without depending on the
// renderer choosing highlighting or on asynchronous highlighter initialization.
function HighlightedPreviewFixture() {
  return (
    <div data-testid="preview-root">
      <div
        className="chat-markdown-codeblock"
        {...sourcePositionProps({
          "data-source-start-line": 10,
          "data-source-end-line": 14,
          "data-source-code-lines": "[11,12,13,14]",
        })}
      >
        <button type="button" className="chat-markdown-copy-button">
          Copy code
        </button>
        <div className="chat-markdown-shiki">
          <pre>
            <code>
              <span className="line">
                <span>first</span>
                <span> value</span>
              </span>
              {"\n"}
              <span className="line">
                <span>sec</span>
                <span>ond</span>
                <span> value</span>
              </span>
              {"\n"}
              <span className="line">
                <span>third</span>
                <span> value</span>
              </span>
              {"\n"}
            </code>
          </pre>
        </div>
      </div>
      <span data-source-text-line="15">
        <span aria-hidden="true">Generated label</span>
      </span>
    </div>
  );
}

describe("Markdown selection in highlighted and generated DOM", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it.each([false, true])(
    "maps a selected line across syntax tokens (backward=%s)",
    async (backward) => {
      const mounted = await render(<HighlightedPreviewFixture />);
      try {
        const root = document.querySelector<HTMLElement>('[data-testid="preview-root"]')!;
        const start = previewTextPoint(root, "sec");
        const end = previewTextPoint(root, "ond");
        expect(
          resolveMarkdownPreviewTextSelection(
            selectPreviewText(start, afterPreviewText(end, "ond"), backward),
            root,
          ),
        ).toEqual({ startLine: 12, endLine: 12, selectedText: "second" });
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("maps multiple highlighted lines without including generated copy-button text", async () => {
    const mounted = await render(<HighlightedPreviewFixture />);
    try {
      const root = document.querySelector<HTMLElement>('[data-testid="preview-root"]')!;
      const start = previewTextPoint(root, "sec");
      const end = previewTextPoint(root, "third");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(start, afterPreviewText(end, "third")),
          root,
        ),
      ).toEqual({ startLine: 12, endLine: 13, selectedText: "second value\nthird" });
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["Copy code", "Generated label"])("rejects generated UI: %s", async (label) => {
    const mounted = await render(<HighlightedPreviewFixture />);
    try {
      const root = document.querySelector<HTMLElement>('[data-testid="preview-root"]')!;
      const point = previewTextPoint(root, label);
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(point, afterPreviewText(point, label)),
          root,
        ),
      ).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
