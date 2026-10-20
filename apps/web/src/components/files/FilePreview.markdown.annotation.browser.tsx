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

function mountPreview(relativePath = "docs/example.md") {
  return render(
    <TooltipProvider>
      <div style={{ width: 600, height: 600 }}>
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
