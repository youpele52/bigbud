import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BaseMarkdown } from "./BaseMarkdown";

describe("BaseMarkdown anchor delegation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete window.desktopBridge;
  });

  it("delegates rendered markdown anchors without opening renderer stores", async () => {
    const onAnchorClick = vi.fn();
    const mounted = await render(
      <BaseMarkdown text="[README](README.md)" cwd="/workspace" onAnchorClick={onAnchorClick} />,
    );

    try {
      await page.getByRole("link", { name: "README" }).click();
      expect(onAnchorClick).toHaveBeenCalledWith({
        href: "README.md",
        workspaceRoot: "/workspace",
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("wraps GFM tables in a responsive scrolling surface", async () => {
    const mounted = await render(
      <BaseMarkdown
        text={"| Status | Details |\n| --- | --- |\n| Partial | In progress |"}
        cwd="/workspace"
      />,
    );

    try {
      expect(document.querySelector(".chat-markdown-table-scroll table")).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["light", "dark"])(
    "uses app scrollbar styling on both table axes in %s mode",
    async (theme) => {
      const wasDark = document.documentElement.classList.contains("dark");
      const rows = Array.from({ length: 60 }, (_, index) => `| ${index} | In progress |`);
      const mounted = await render(
        <BaseMarkdown
          text={["| Status | Details |", "| --- | --- |", ...rows].join("\n")}
          cwd="/workspace"
        />,
      );

      document.documentElement.classList.toggle("dark", theme === "dark");

      const expectAppScrollbar = (scroller: HTMLElement) => {
        expect(getComputedStyle(scroller).scrollbarWidth).toBe("auto");
        const scrollbar = getComputedStyle(scroller, "::-webkit-scrollbar");
        expect(scrollbar.width).toBe("6px");
        expect(scrollbar.height).toBe("6px");
        for (const part of ["track", "corner"]) {
          expect(getComputedStyle(scroller, `::-webkit-scrollbar-${part}`).backgroundColor).toBe(
            "rgba(0, 0, 0, 0)",
          );
        }
        const thumb = getComputedStyle(scroller, "::-webkit-scrollbar-thumb");
        expect(thumb.borderRadius).toBe("3px");
        const thumbColors =
          theme === "dark"
            ? ["rgba(255, 255, 255, 0.1)", "rgba(255, 255, 255, 0.18)"]
            : ["rgba(0, 0, 0, 0.15)", "rgba(0, 0, 0, 0.25)"];
        expect(thumbColors).toContain(thumb.backgroundColor);
      };

      try {
        const inlineScroller = document.querySelector<HTMLElement>(".chat-markdown-table-scroll");
        expect(inlineScroller).toBeInstanceOf(HTMLElement);
        if (!inlineScroller) {
          throw new Error("Inline table scroller was not rendered");
        }
        expectAppScrollbar(inlineScroller);
        expect(inlineScroller.scrollWidth).toBeGreaterThan(inlineScroller.clientWidth);
        inlineScroller.scrollLeft = 100;
        await expect.poll(() => inlineScroller.scrollLeft).toBeGreaterThan(0);

        await page.getByRole("region", { name: "Scrollable table" }).hover();
        await page.getByRole("button", { name: "Open table" }).click();
        const dialog = page.getByRole("dialog");
        await expect.element(dialog).toBeVisible();
        const expandedScroller = dialog
          .element()
          .querySelector<HTMLElement>(".chat-markdown-table-expanded");
        expect(expandedScroller).toBeInstanceOf(HTMLElement);
        if (!expandedScroller) {
          throw new Error("Expanded table scroller was not rendered");
        }
        expectAppScrollbar(expandedScroller);
        expect(expandedScroller.scrollWidth).toBeGreaterThan(expandedScroller.clientWidth);
        expect(expandedScroller.scrollHeight).toBeGreaterThan(expandedScroller.clientHeight);
        expandedScroller.scrollLeft = 100;
        expandedScroller.scrollTop = 100;
        await expect.poll(() => expandedScroller.scrollLeft).toBeGreaterThan(0);
        await expect.poll(() => expandedScroller.scrollTop).toBeGreaterThan(0);
      } finally {
        await mounted.unmount();
        document.documentElement.classList.toggle("dark", wasDark);
      }
    },
  );

  it("copies tables as markdown and opens them in a dialog", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const mounted = await render(
      <BaseMarkdown
        text={"| Status | Details |\n| --- | --- |\n| Partial | In progress |"}
        cwd="/workspace"
      />,
    );

    try {
      const table = page.getByRole("region", { name: "Scrollable table" });
      await table.hover();
      await page.getByRole("button", { name: "Copy table" }).click();
      expect(writeText).toHaveBeenCalledWith(
        "| Status | Details |\n| --- | --- |\n| Partial | In progress |",
      );

      await page.getByRole("button", { name: "Open table" }).click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      await expect.element(dialog).toHaveClass("chat-markdown-table-dialog");
      expect(dialog.element().textContent).toContain("In progress");
      expect(Number.parseFloat(getComputedStyle(dialog.element()).width)).toBeCloseTo(
        Math.min(window.innerWidth * 0.75, window.innerWidth - 32),
        0,
      );

      const expandedScroller = dialog
        .element()
        .querySelector<HTMLElement>(".chat-markdown-table-expanded");
      const backdrop = document.querySelector<HTMLElement>("[data-slot='dialog-backdrop']");
      expect(expandedScroller).toBeInstanceOf(HTMLElement);
      expect(backdrop).toBeInstanceOf(HTMLElement);
      if (!(expandedScroller instanceof HTMLElement) || !(backdrop instanceof HTMLElement)) {
        throw new Error("Expanded table surfaces were not rendered");
      }

      const expandedRow = expandedScroller.querySelector("tr");
      const expandedScrollerParent = expandedScroller.parentElement;
      expect(expandedRow).toBeInstanceOf(HTMLTableRowElement);
      expect(expandedScrollerParent).toBeInstanceOf(HTMLElement);
      if (!(expandedRow instanceof HTMLTableRowElement) || !expandedScrollerParent) {
        throw new Error("Expanded table structure was not rendered");
      }

      expect(getComputedStyle(expandedScrollerParent).overflowX).toBe("visible");
      expect(getComputedStyle(expandedRow).transitionDuration).toBe("0s");
      expect(getComputedStyle(backdrop).backdropFilter).toBe("none");
      expect(getComputedStyle(dialog.element()).willChange).toBe("auto");
      expect(expandedScroller.scrollWidth).toBeGreaterThan(expandedScroller.clientWidth);

      expandedScroller.scrollLeft = 100;
      await expect.poll(() => expandedScroller.scrollLeft).toBeGreaterThan(0);

      await page.getByRole("button", { name: "Close" }).click();
      await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
