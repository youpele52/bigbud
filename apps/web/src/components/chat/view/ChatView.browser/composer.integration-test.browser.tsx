import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@bigbud/contracts";
import { useComposerDraftStore } from "../../../../stores/composer";
import { useTerminalStateStore } from "../../../../stores/terminal";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, THREAD_ID, createSnapshotForTargetUser } from "./fixtures";
import { waitForComposerEditor, waitForSendButton } from "./dom";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView composer integration", () => {
  it("submits bang-prefixed prompts through thread.shell.run", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-command-target" as never,
        targetText: "terminal command thread",
      }),
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && body.type === "thread.shell.run"
          ? { sequence: 2 }
          : undefined,
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("! ls");

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(() => {
        expect(
          ctx.wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.shell.run",
          ),
        ).toMatchObject({
          _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
          type: "thread.shell.run",
          threadId: THREAD_ID,
          shellCommand: "ls",
          message: {
            text: "ls",
          },
        });
      });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="composer-editor"]')?.textContent).toBe("");
      });
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("! ls");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches the composer into shell mode when ! is typed first", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-shell-mode-target" as never,
        targetText: "shell mode thread",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await page.getByTestId("composer-editor").fill("!");

      await vi.waitFor(() => {
        const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
        expect(editor?.getAttribute("aria-placeholder")).toBe("Enter shell command");
        expect(editor?.textContent).toBe("");
        expect(document.body.textContent).toContain("Enter shell command");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps composer focus while an open terminal finishes hydrating", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [THREAD_ID]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
    });

    const releaseTerminalOpen = { current: null as (() => void) | null };
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-target" as never,
        targetText: "composer focus thread",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
          return undefined;
        }
        if (body._tag === WS_METHODS.terminalOpen) {
          return new Promise((resolve) => {
            releaseTerminalOpen.current = () =>
              resolve({
                threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
                terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
                cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
                worktreePath: typeof body.worktreePath === "string" ? body.worktreePath : null,
                status: "running",
                pid: 123,
                history: "",
                exitCode: null,
                exitSignal: null,
                updatedAt: new Date().toISOString(),
              });
          });
        }
        return undefined;
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await page.getByTestId("composer-editor").fill("typing while terminal loads");

      releaseTerminalOpen.current?.();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "typing while terminal loads",
        );
        expect(document.activeElement).toBe(composerEditor);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps composer focus while typing with an already-open terminal", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [THREAD_ID]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-open-terminal" as never,
        targetText: "composer focus open terminal thread",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
          return undefined;
        }
        if (body._tag === WS_METHODS.terminalOpen) {
          return {
            threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
            terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
            cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
            worktreePath: typeof body.worktreePath === "string" ? body.worktreePath : null,
            status: "running",
            pid: 123,
            history: "",
            exitCode: null,
            exitSignal: null,
            updatedAt: new Date().toISOString(),
          };
        }
        return undefined;
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      await page.getByTestId("composer-editor").fill("first line");
      await page.getByTestId("composer-editor").fill("first line\nsecond line");
      await page.getByTestId("composer-editor").fill("first line\nsecond line\nthird line");

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "first line\nsecond line\nthird line",
        );
        expect(document.activeElement).toBe(composerEditor);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as never,
        targetText: "hotkey target",
      }),
    });

    try {
      await waitForComposerEditor();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode,
      ).toBeUndefined();

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode,
      ).toBeUndefined();

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode).toBe(
          "plan",
        );
      });

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode).toBe(
          "default",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
