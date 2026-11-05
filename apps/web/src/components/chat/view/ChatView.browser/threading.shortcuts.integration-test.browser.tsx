import { type ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, UUID_ROUTE_RE, createSnapshotForTargetUser } from "./fixtures";
import {
  dispatchCommandPaletteShortcut,
  dispatchSidebarToggleShortcut,
  triggerChatNewShortcutUntilPath,
  waitForComposerEditor,
  waitForElement,
  waitForNewThreadShortcutLabel,
  waitForURL,
} from "./dom";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView threading shortcuts integration", () => {
  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as never,
        targetText: "chat shortcut test",
      }),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await ctx.waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the sidebar from mod+b while the composer is focused", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-shortcut-test" as never,
        targetText: "sidebar shortcut test",
      }),
    });

    try {
      await ctx.waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      const sidebarRoot = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="sidebar"]'),
        "Unable to find sidebar root.",
      );

      expect(sidebarRoot.dataset.state).toBe("expanded");
      composerEditor.focus();
      dispatchSidebarToggleShortcut();
      await vi.waitFor(() => {
        expect(sidebarRoot.dataset.state).toBe("collapsed");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the command palette from mod+p while the composer is focused", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-shortcut-test" as never,
        targetText: "command palette shortcut test",
      }),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "p",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
            },
          ],
        };
      },
    });

    try {
      await ctx.waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      dispatchCommandPaletteShortcut();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="command-palette"]')).toBeTruthy();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as never,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForNewThreadShortcutLabel();
      await ctx.waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      await ctx.promoteDraftThreadViaDomainEvent(promotedThreadPath.slice(1) as ThreadId);

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });
});
