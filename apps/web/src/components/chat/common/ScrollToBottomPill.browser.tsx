import "../../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ScrollToBottomPill } from "./ScrollToBottomPill";

describe("ScrollToBottomPill", () => {
  it("renders an accessible circular scroll button", async () => {
    const onScrollToBottom = vi.fn();
    await render(<ScrollToBottomPill onScrollToBottom={onScrollToBottom} />);

    const button = page.getByRole("button", { name: "Scroll to bottom" });
    await expect.element(button).toHaveClass("rounded-full");

    await button.click();
    expect(onScrollToBottom).toHaveBeenCalledOnce();
  });
});
