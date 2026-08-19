import { describe, expect, it } from "vitest";

import {
  isCompactChatLinkHandoff,
  isDesktopMenuAction,
  isDesktopRendererReadyAction,
  MAX_COMPACT_LINK_HREF_LENGTH,
} from "./menuAction.validation";

describe("desktop menu action validation", () => {
  it("accepts bounded compact link handoffs and renderer readiness", () => {
    const handoff = {
      type: "compact-chat-link",
      threadId: "thread-1",
      href: "src/index.ts:4",
      workspaceRoot: "/workspace",
    };

    expect(isCompactChatLinkHandoff(handoff)).toBe(true);
    expect(isDesktopMenuAction(handoff)).toBe(true);
    expect(isDesktopRendererReadyAction({ type: "desktop-renderer-ready", role: "main" })).toBe(
      true,
    );
  });

  it("rejects malformed, oversized, and unknown structured actions", () => {
    expect(
      isCompactChatLinkHandoff({
        type: "compact-chat-link",
        threadId: " ",
        href: "README.md",
        workspaceRoot: null,
      }),
    ).toBe(false);
    expect(
      isCompactChatLinkHandoff({
        type: "compact-chat-link",
        threadId: "thread-1",
        href: "x".repeat(MAX_COMPACT_LINK_HREF_LENGTH + 1),
        workspaceRoot: null,
      }),
    ).toBe(false);
    expect(isDesktopMenuAction({ type: "unknown-action" })).toBe(false);
    expect(
      isDesktopRendererReadyAction({ type: "desktop-renderer-ready", role: "compact-chat" }),
    ).toBe(false);
  });

  it("preserves legacy string actions", () => {
    expect(isDesktopMenuAction("open-settings")).toBe(true);
  });
});
