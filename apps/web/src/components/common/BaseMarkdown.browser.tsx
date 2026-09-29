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

      await page.getByRole("button", { name: "Close" }).click();
      await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
