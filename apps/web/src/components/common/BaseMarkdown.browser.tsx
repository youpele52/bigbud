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
});
