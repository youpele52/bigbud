import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useSideChatAutoScroll } from "./sideChat.scroll.hooks";

function SideChatScrollHarness() {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const { onScroll, scrollToBottom, showScrollToBottom } = useSideChatAutoScroll({
    contentElement: null,
    contentVersion: 0,
    isWorking: false,
    scrollContainer,
  });

  return (
    <div ref={setScrollContainer} data-testid="scroll-container" onScroll={onScroll}>
      {showScrollToBottom ? (
        <button type="button" onClick={scrollToBottom}>
          Scroll to bottom
        </button>
      ) : null}
    </div>
  );
}

describe("useSideChatAutoScroll", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a manual scroll control away from the bottom and restores auto-scroll on click", async () => {
    const mounted = await render(<SideChatScrollHarness />);

    try {
      const scrollContainer = document.querySelector('[data-testid="scroll-container"]');
      if (!(scrollContainer instanceof HTMLDivElement)) {
        throw new Error("Expected the side chat scroll container.");
      }
      const scrollTo = vi.fn();
      Object.defineProperties(scrollContainer, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 400 },
        scrollTo: { configurable: true, value: scrollTo },
      });

      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));

      const button = page.getByRole("button", { name: "Scroll to bottom" });
      await expect.element(button).toBeInTheDocument();
      await button.click();

      expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 400 });
      await expect.element(button).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});
