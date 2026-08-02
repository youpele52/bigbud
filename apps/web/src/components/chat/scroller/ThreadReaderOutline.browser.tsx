import "../../../index.css";

import { type MessageId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadReaderOutline } from "./ThreadReaderOutline";

const FIRST_PREVIEW = "First user message preview that is long enough to recognize.";
const SECOND_PREVIEW = "Second user message preview that must navigate to its exact message.";

async function mountOutline(onJumpToMessage = vi.fn()) {
  const host = document.createElement("div");
  host.style.height = "180px";
  host.style.width = "40px";
  document.body.append(host);
  const screen = await render(
    <ThreadReaderOutline
      anchors={[
        { messageId: "user-1" as MessageId, label: FIRST_PREVIEW },
        { messageId: "user-2" as MessageId, label: SECOND_PREVIEW },
      ]}
      currentAnchorMessageId={"user-1" as MessageId}
      onJumpToMessage={onJumpToMessage}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    onJumpToMessage,
  };
}

describe("ThreadReaderOutline", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the rail transparent, reveals the hovered preview, and jumps by message id", async () => {
    const mounted = await mountOutline();

    try {
      const outline = document.querySelector<HTMLElement>('[aria-label="Transcript outline"]');
      expect(outline?.className).toContain("overflow-visible");
      expect(outline?.className).not.toContain("hover:bg-accent/20");

      const target = page.getByLabelText(SECOND_PREVIEW);
      await target.hover();
      await expect.element(page.getByText(SECOND_PREVIEW)).toBeVisible();

      await target.click();
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      expect(mounted.onJumpToMessage).toHaveBeenCalledWith("user-2");
    } finally {
      await mounted.cleanup();
    }
  });
});
