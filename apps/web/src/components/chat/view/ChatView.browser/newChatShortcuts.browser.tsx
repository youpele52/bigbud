import { BUILT_IN_CHATS_PROJECT_ID, MessageId, ThreadId } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useComposerDraftStore } from "../../../../stores/composer";
import { createChatViewBrowserTestContext } from "./context";
import {
  DEFAULT_VIEWPORT,
  PROJECT_ID,
  UUID_ROUTE_RE,
  createSnapshotForTargetUser,
} from "./fixtures";
import { waitForComposerEditor, waitForURL } from "./dom";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

it.each([false, true])(
  "routes mod+n (alt=%s) to the correct project and directory",
  async (altKey) => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("shortcut-context"),
      targetText: "Shortcut context",
    });
    const project = snapshot.projects[0]!;
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: [
          ...snapshot.projects,
          { ...project, id: BUILT_IN_CHATS_PROJECT_ID, title: "Chats", workspaceRoot: null },
        ],
        threads: snapshot.threads.map((thread) =>
          Object.assign(thread, { branch: "main", worktreePath: "/repo/worktree" }),
        ),
      },
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          keybindings: [
            {
              command: altKey ? "chat.newLocal" : "chat.new",
              shortcut: {
                key: "n",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey,
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
      (await waitForComposerEditor()).focus();
      const isMac = navigator.platform.toLowerCase().includes("mac");
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: altKey && isMac ? "˜" : "n",
          code: "KeyN",
          metaKey: isMac,
          ctrlKey: !isMac,
          altKey,
          bubbles: true,
          cancelable: true,
        }),
      );
      const path = await waitForURL(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Shortcut should open a draft",
      );
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().getDraftThread(ThreadId.makeUnsafe(path.slice(1))),
        ).toMatchObject({
          projectId: altKey ? BUILT_IN_CHATS_PROJECT_ID : PROJECT_ID,
          branch: altKey ? null : "main",
          worktreePath: altKey ? null : "/repo/worktree",
          envMode: altKey ? "local" : "worktree",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  },
);

it.each([false, true])(
  "sidebar new chat button (Chats section=%s) matches its shortcut",
  async (inChats) => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("sidebar-new-chat"),
      targetText: "Sidebar new chat",
    });
    const project = snapshot.projects[0]!;
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: [
          ...snapshot.projects,
          { ...project, id: BUILT_IN_CHATS_PROJECT_ID, title: "Chats", workspaceRoot: null },
        ],
        threads: snapshot.threads.map((thread) =>
          Object.assign(thread, { branch: "main", worktreePath: "/repo/worktree" }),
        ),
      },
    });
    try {
      await ctx.waitForServerConfigToApply();
      await waitForComposerEditor();
      const buttons = page.getByRole("button", { name: "New chat", exact: true });
      await buttons.nth(inChats ? 1 : 0).click();
      const path = await waitForURL(
        mounted.router,
        (pathname) => UUID_ROUTE_RE.test(pathname),
        "Sidebar button should open a draft",
      );
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().getDraftThread(ThreadId.makeUnsafe(path.slice(1))),
        ).toMatchObject({
          projectId: inChats ? BUILT_IN_CHATS_PROJECT_ID : PROJECT_ID,
          branch: inChats ? null : "main",
          worktreePath: inChats ? null : "/repo/worktree",
          envMode: inChats ? "local" : "worktree",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  },
);
