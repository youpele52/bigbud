import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { FilePreviewMarkdownContent } from "./FilePreview.markdown";
import { resolveMarkdownPreviewTextSelection } from "./FilePreview.markdown.selection";
import {
  afterPreviewText,
  previewTextPoint,
  selectPreviewText,
} from "./FilePreview.markdown.selection.browser.utils";

async function mountMarkdown(contents: string) {
  const mounted = await render(<FilePreviewMarkdownContent contents={contents} cwd="/workspace" />);
  return { mounted, root: document.querySelector<HTMLElement>(".file-preview-markdown")! };
}

describe("Markdown preview selection source mapping", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("uses the selected occurrence rather than the first matching source text", async () => {
    const { mounted, root } = await mountMarkdown("repeat\n\nrepeat");
    try {
      const start = previewTextPoint(root, "repeat", 1);
      const selection = selectPreviewText(start, afterPreviewText(start, "repeat"));
      expect(resolveMarkdownPreviewTextSelection(selection, root)).toEqual({
        startLine: 3,
        endLine: 3,
        selectedText: "repeat",
      });
    } finally {
      await mounted.unmount();
    }
  });

  it.each([false, true])(
    "maps formatted multi-block selections (backward=%s)",
    async (backward) => {
      const { mounted, root } = await mountMarkdown(
        "# A **heading**\n\nParagraph with `inline` code.\n\n- A [linked item](https://example.com)\n- Last item",
      );
      try {
        const start = previewTextPoint(root, "heading");
        const end = previewTextPoint(root, "linked item");
        const selection = selectPreviewText(start, afterPreviewText(end, "linked item"), backward);
        expect(resolveMarkdownPreviewTextSelection(selection, root)).toMatchObject({
          startLine: 1,
          endLine: 5,
        });
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("maps a partial line inside a multiline paragraph, including formatted text", async () => {
    const { mounted, root } = await mountMarkdown("first line\nsecond **bold** line\nthird line");
    try {
      const start = previewTextPoint(root, "second");
      const end = previewTextPoint(root, "bold");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(start, afterPreviewText(end, "bold")),
          root,
        ),
      ).toMatchObject({ startLine: 2, endLine: 2 });
    } finally {
      await mounted.unmount();
    }
  });

  it("maps multiline inline code after Markdown normalizes its newlines to spaces", async () => {
    const { mounted, root } = await mountMarkdown("before `first\nsecond` after");
    try {
      const start = previewTextPoint(root.querySelector("code")!, "second");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(start, afterPreviewText(start, "second")),
          root,
        ),
      ).toMatchObject({ startLine: 2, endLine: 2 });
    } finally {
      await mounted.unmount();
    }
  });

  it("maps multiline emphasis and decoded entities without inventing source lines", async () => {
    const { mounted, root } = await mountMarkdown("**first\nsecond**\n\nEntity &#10; continuation");
    try {
      const start = previewTextPoint(root, "second");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(start, afterPreviewText(start, "second")),
          root,
        ),
      ).toMatchObject({ startLine: 2, endLine: 2 });
      const entity = previewTextPoint(root, "continuation");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(entity, afterPreviewText(entity, "continuation")),
          root,
        ),
      ).toMatchObject({ startLine: 4, endLine: 4 });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps nested-list own text separate from descendant list ranges", async () => {
    const { mounted, root } = await mountMarkdown("- Parent\n  - Child **bold**\n- Sibling");
    try {
      const start = previewTextPoint(root, "Child");
      const end = previewTextPoint(root, "bold");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(start, afterPreviewText(end, "bold")),
          root,
        ),
      ).toMatchObject({ startLine: 2, endLine: 2 });
      const parent = previewTextPoint(root, "Parent");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(parent, afterPreviewText(parent, "Parent")),
          root,
        ),
      ).toMatchObject({ startLine: 1, endLine: 1 });
    } finally {
      await mounted.unmount();
    }
  });

  it("maps table cells and excludes a row whose start is the selection end", async () => {
    const { mounted, root } = await mountMarkdown(
      "| Name | Value |\n| --- | --- |\n| one | 1 |\n| two | 2 |",
    );
    try {
      const start = previewTextPoint(root, "Name");
      const next = previewTextPoint(root, "two");
      expect(
        resolveMarkdownPreviewTextSelection(selectPreviewText(start, next), root),
      ).toMatchObject({ startLine: 1, endLine: 3 });
    } finally {
      await mounted.unmount();
    }
  });

  it("maps YAML frontmatter through the rendered-to-original line map", async () => {
    const { mounted, root } = await mountMarkdown(
      "---\ntitle: Example\nmetadata:\n  version: 2\n---\n# Heading",
    );
    try {
      const start = previewTextPoint(root, "title:");
      const end = previewTextPoint(root, "version:");
      expect(
        resolveMarkdownPreviewTextSelection(
          selectPreviewText(start, afterPreviewText(end, "version:")),
          root,
        ),
      ).toMatchObject({ startLine: 2, endLine: 4 });
    } finally {
      await mounted.unmount();
    }
  });

  it.each([
    { contents: "```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\n```", line: 3 },
    { contents: "    first\n    second\n    third", line: 2 },
    { contents: "> ```text\n> first\n> second\n> third\n> ```", line: 3 },
  ])(
    "maps partial code selections in the renderer's fallback DOM: $line",
    async ({ contents, line }) => {
      const { mounted, root } = await mountMarkdown(contents);
      try {
        const code = root.querySelector("pre code")!;
        expect(code.closest("[data-source-code-lines]")).not.toBeNull();
        const start = previewTextPoint(code, "second");
        expect(
          resolveMarkdownPreviewTextSelection(
            selectPreviewText(start, afterPreviewText(start, "second")),
            root,
          ),
        ).toMatchObject({ startLine: line, endLine: line });
      } finally {
        await mounted.unmount();
      }
    },
  );

  it.each([false, true])(
    "maps nested highlighted spans using wrapper metadata (backward=%s)",
    async (backward) => {
      const mounted = await render(
        <div className="chat-markdown-codeblock" data-source-code-lines="[11,17,23,null]">
          <div className="chat-markdown-shiki">
            <pre className="shiki">
              <code>
                <span className="line">
                  <span>first</span>
                  <span> = 1;</span>
                </span>
                {"\n"}
                <span className="line">
                  <span>
                    sec<span>ond</span>
                  </span>
                  <span> = </span>
                  <span>2;</span>
                </span>
                {"\n"}
                <span className="line">
                  <span>third</span>
                  <span> = 3;</span>
                </span>
                {"\n"}
              </code>
            </pre>
          </div>
        </div>,
      );
      const root = document.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
      try {
        const second = previewTextPoint(root, "sec");
        const end = previewTextPoint(root, "2;");
        expect(
          resolveMarkdownPreviewTextSelection(
            selectPreviewText(
              { ...second, offset: second.offset + 1 },
              afterPreviewText(end, "2;"),
              backward,
            ),
            root,
          ),
        ).toEqual({ startLine: 17, endLine: 17, selectedText: "econd = 2;" });

        const first = previewTextPoint(root, "first");
        const third = previewTextPoint(root, "third");
        expect(
          resolveMarkdownPreviewTextSelection(selectPreviewText(first, third, backward), root),
        ).toMatchObject({ startLine: 11, endLine: 17 });
        expect(
          resolveMarkdownPreviewTextSelection(
            selectPreviewText(second, afterPreviewText(third, "third"), backward),
            root,
          ),
        ).toMatchObject({ startLine: 17, endLine: 23 });
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("rejects generated buttons and hidden UI even inside source metadata", async () => {
    const mounted = await render(
      <div data-source-text-line={99}>
        <button type="button">
          <span>Copy code</span>
        </button>
        <span aria-hidden="true">
          <span>Generated label</span>
        </span>
      </div>,
    );
    const root = document.querySelector<HTMLElement>("[data-source-text-line]")!;
    try {
      for (const text of ["Copy code", "Generated label"]) {
        const start = previewTextPoint(root, text);
        expect(
          resolveMarkdownPreviewTextSelection(
            selectPreviewText(start, afterPreviewText(start, text)),
            root,
          ),
        ).toBeNull();
      }
    } finally {
      await mounted.unmount();
    }
  });

  it("rejects collapsed, short, whitespace-only and outside selections", async () => {
    const { mounted, root } = await mountMarkdown("Body text\n\n```\ncode\n```");
    try {
      const selection = window.getSelection()!;
      const start = previewTextPoint(root, "Body");
      selection.collapse(start.node, start.offset);
      expect(resolveMarkdownPreviewTextSelection(selection, root)).toBeNull();
      selectPreviewText(start, { ...start, offset: start.offset + 1 });
      expect(resolveMarkdownPreviewTextSelection(selection, root)).toBeNull();
      const space = { ...start, offset: start.offset + 4 };
      selectPreviewText(space, { ...space, offset: space.offset + 1 });
      expect(resolveMarkdownPreviewTextSelection(selection, root)).toBeNull();
      const outside = document.createTextNode("Outside selection");
      document.body.append(outside);
      selectPreviewText(start, { node: outside, offset: 7 });
      expect(resolveMarkdownPreviewTextSelection(selection, root)).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("excludes the next block when a selection ends at its element boundary", async () => {
    const { mounted, root } = await mountMarkdown("First block\n\nSecond block");
    try {
      const start = previewTextPoint(root, "First");
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(root.querySelectorAll("p")[1]!, 0);
      const selection = window.getSelection()!;
      selection.addRange(range);
      expect(resolveMarkdownPreviewTextSelection(selection, root)).toMatchObject({
        startLine: 1,
        endLine: 1,
      });
    } finally {
      await mounted.unmount();
    }
  });
});
