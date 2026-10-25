import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  afterPreviewText,
  previewTextPoint,
  selectPreviewText,
} from "./FilePreview.markdown.selection.browser.utils";

const mocks = vi.hoisted(() => ({ read: vi.fn(), menu: vi.fn(), annotation: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => {
  const api = {
    projects: { readFilePreview: mocks.read, onDirectoryChange: () => () => {} },
    contextMenu: { show: mocks.menu },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});
vi.mock("../../rpc/serverState", () => ({ useServerConfig: () => ({}) }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { FilePreview } from "./FilePreview";
import { TooltipProvider } from "../ui/tooltip";

const CONTENTS = [
  "---",
  "title: Example",
  "---",
  "# A **heading**",
  "",
  "Paragraph with `inline` code.",
  "",
  "- A [linked item](https://example.com)",
].join("\n");

function mountPreview(relativePath = "docs/example.md", width = 600, height = 600) {
  return render(
    <TooltipProvider>
      <div style={{ width, height }}>
        <FilePreview
          cwd="/workspace"
          relativePath={relativePath}
          canNavigateBack={false}
          canNavigateForward={false}
          onNavigateBack={() => {}}
          onNavigateForward={() => {}}
          onClose={() => {}}
          onCreateAnnotation={mocks.annotation}
        />
      </div>
    </TooltipProvider>,
  );
}

function openSelectionMenu(root: HTMLElement) {
  root.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("Markdown preview annotation workflow", () => {
  beforeEach(() => {
    mocks.read.mockReset().mockResolvedValue({ contents: CONTENTS, truncated: false });
    mocks.menu.mockReset().mockResolvedValue("annotate-selection");
    mocks.annotation.mockReset();
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("opens only through Annotate selection and displays/submits all original Markdown lines", async () => {
    const mounted = await mountPreview();
    try {
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
      );
      const root = document.querySelector<HTMLElement>(".file-preview-markdown")!;
      const start = previewTextPoint(root, "heading");
      const end = previewTextPoint(root, "linked item");
      selectPreviewText(start, afterPreviewText(end, "linked item"));
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(document.querySelector("[data-annotation-composer]")).toBeNull();
      openSelectionMenu(root);

      await vi.waitFor(() =>
        expect(document.querySelector("[data-annotation-composer]")).not.toBeNull(),
      );
      expect(mocks.menu.mock.calls[0]![0]).toContainEqual({
        id: "annotate-selection",
        label: "Annotate selection",
      });
      expect(document.querySelector("#annotation-composer-target")?.textContent).toBe("Lines 4-8");
      const snippet = CONTENTS.split("\n").slice(3, 8).join("\n");
      const sourcePreview = page.getByLabelText("Selected source lines");
      await expect.element(sourcePreview).not.toBeVisible();
      await page.getByText("Lines 4-8", { exact: true }).click();
      await expect.element(sourcePreview).toBeVisible();
      expect(document.querySelector('[aria-label="Selected source lines"]')?.textContent).toBe(
        snippet,
      );
      await page.getByRole("textbox").fill("Please review these lines");
      await page.getByText("Lines 4-8", { exact: true }).click();
      await expect.element(sourcePreview).not.toBeVisible();
      await expect.element(page.getByRole("textbox")).toHaveValue("Please review these lines");
      await page.getByRole("button", { name: "Add comment", exact: true }).click();
      expect(mocks.annotation).toHaveBeenCalledWith({
        intent: "comment",
        comment: "Please review these lines",
        startLine: 4,
        endLine: 8,
        text: snippet,
      });
      expect(document.querySelector("[data-annotation-composer]")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("does not offer annotation for a selection outside preview content", async () => {
    const mounted = await mountPreview();
    try {
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
      );
      const root = document.querySelector<HTMLElement>(".file-preview-markdown")!;
      const outside = document.createTextNode("Outside text");
      document.body.append(outside);
      selectPreviewText({ node: outside, offset: 0 }, { node: outside, offset: 7 });
      openSelectionMenu(root);
      expect(mocks.menu.mock.calls[0]![0]).not.toContainEqual({
        id: "annotate-selection",
        label: "Annotate selection",
      });
      expect(document.querySelector("[data-annotation-composer]")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it.each([false, true])(
    "anchors below the last selected wrapped text line, including backward selections: %s",
    async (backward) => {
      const text = "Wrapped words with **formatting** and more text. ".repeat(14);
      mocks.read.mockResolvedValue({ contents: text, truncated: false });
      // Native menus may clear the live selection before returning the chosen action.
      mocks.menu.mockImplementation(async () => {
        window.getSelection()?.removeAllRanges();
        return "annotate-selection";
      });
      const mounted = await mountPreview("docs/wrapped.md", 360, 800);
      try {
        await vi.waitFor(() =>
          expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
        );
        const root = document.querySelector<HTMLElement>(".file-preview-markdown")!;
        const start = previewTextPoint(root, "Wrapped words");
        const end = afterPreviewText(previewTextPoint(root, "more text.", 2), "more text.");
        const selection = selectPreviewText(start, end, backward);
        const lastCharacter = selection.getRangeAt(0).cloneRange();
        lastCharacter.setStart(end.node, end.offset - 1);
        const selectedBottom = lastCharacter.getBoundingClientRect().bottom;
        expect(root.querySelector("p")!.getBoundingClientRect().bottom).toBeGreaterThan(
          selectedBottom + 100,
        );
        openSelectionMenu(root);
        await vi.waitFor(() => {
          const composer = document.querySelector<HTMLElement>("[data-annotation-composer]")!;
          expect(composer).not.toBeNull();
          expect(composer.getBoundingClientRect().top).toBeCloseTo(selectedBottom + 8, 0);
        });
        expect(document.querySelector("#annotation-composer-target")?.textContent).toBe("Line 1");
        const frame = root.closest<HTMLElement>("[data-file-preview-search-focus]")!.parentElement!;
        frame.style.width = "280px";
        await vi.waitFor(() => {
          const composer = document.querySelector<HTMLElement>("[data-annotation-composer]")!;
          expect(lastCharacter.getBoundingClientRect().bottom).toBeGreaterThan(selectedBottom);
          expect(composer.getBoundingClientRect().top).toBeCloseTo(
            lastCharacter.getBoundingClientRect().bottom + 8,
            0,
          );
        });
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("flips above a selection near the viewport bottom and follows scrolling", async () => {
    const contents = Array.from({ length: 60 }, (_, index) => `Paragraph ${index} text.`).join(
      "\n\n",
    );
    mocks.read.mockResolvedValue({ contents, truncated: false });
    const mounted = await mountPreview();
    try {
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
      );
      const root = document.querySelector<HTMLElement>(".file-preview-markdown")!;
      const scroll = root.parentElement!.parentElement!;
      const start = previewTextPoint(root, "Paragraph 20 text.");
      const end = afterPreviewText(start, "Paragraph 20 text.");
      const selection = selectPreviewText(start, end);
      const range = selection.getRangeAt(0).cloneRange();
      scroll.scrollTop +=
        range.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom + 24;
      openSelectionMenu(root);
      await vi.waitFor(() => {
        const composer = document.querySelector<HTMLElement>("[data-annotation-composer]")!;
        expect(composer).not.toBeNull();
        expect(composer.getBoundingClientRect().bottom).toBeCloseTo(
          range.getBoundingClientRect().top - 8,
          0,
        );
      });
      scroll.scrollTop += 330;
      await vi.waitFor(() => {
        const composer = document.querySelector<HTMLElement>("[data-annotation-composer]")!;
        expect(composer.getBoundingClientRect().top).toBeCloseTo(
          range.getBoundingClientRect().bottom + 8,
          0,
        );
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the composer inside a narrow, short preview when neither side fits", async () => {
    const mounted = await mountPreview("docs/small.md", 280, 240);
    try {
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
      );
      const root = document.querySelector<HTMLElement>(".file-preview-markdown")!;
      const scroll = root.parentElement!.parentElement!;
      const start = previewTextPoint(root, "heading");
      selectPreviewText(start, afterPreviewText(start, "heading"));
      openSelectionMenu(root);
      await vi.waitFor(() => {
        const composer = document.querySelector<HTMLElement>("[data-annotation-composer]")!;
        expect(composer).not.toBeNull();
        const bounds = composer.parentElement!.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(viewport.left + 7);
        expect(bounds.right).toBeLessThanOrEqual(viewport.right - 7);
        expect(bounds.top).toBeGreaterThanOrEqual(viewport.top + 7);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom - 7);
        expect(composer.parentElement!.scrollHeight).toBeGreaterThan(
          composer.parentElement!.clientHeight,
        );
      });
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["docs/example.md", "example.txt"])(
    "preserves raw multiline selection and source submission: %s",
    async (path) => {
      mocks.read.mockResolvedValue({ contents: "alpha\nbeta value\ngamma", truncated: false });
      const mounted = await mountPreview(path);
      try {
        if (path.endsWith(".md")) {
          await vi.waitFor(() =>
            expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
          );
          await page.getByRole("button", { name: "View raw markdown" }).click();
        }
        await vi.waitFor(() =>
          expect(document.querySelector(".file-preview-code pre")).not.toBeNull(),
        );
        const root = document.querySelector<HTMLElement>(".file-preview-code")!;
        const start = previewTextPoint(root, "alpha");
        const end = previewTextPoint(root, "beta value");
        selectPreviewText(start, afterPreviewText(end, "beta value"));
        root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
        await vi.waitFor(() =>
          expect(document.querySelector("#annotation-composer-target")?.textContent).toBe(
            "Lines 1-2",
          ),
        );
        const sourcePreview = page.getByLabelText("Selected source lines");
        await expect.element(sourcePreview).not.toBeVisible();
        await page.getByText("Lines 1-2", { exact: true }).click();
        await expect.element(sourcePreview).toBeVisible();
        expect(document.querySelector('[aria-label="Selected source lines"]')?.textContent).toBe(
          "alpha\nbeta value",
        );
        await page.getByRole("button", { name: "Add comment", exact: true }).click();
        expect(mocks.annotation).toHaveBeenCalledWith({
          intent: "comment",
          comment: "",
          startLine: 1,
          endLine: 2,
          text: "alpha\nbeta value",
        });
      } finally {
        await mounted.unmount();
      }
    },
  );
});
