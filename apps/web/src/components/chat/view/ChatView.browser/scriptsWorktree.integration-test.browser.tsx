import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../../../../stores/composer";
import { useTerminalStateStore } from "../../../../stores/terminal";
import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, PROJECT_ID, THREAD_ID } from "./fixtures";
import {
  createDraftOnlySnapshot,
  withProjectScripts,
  buildWorktreeSnapshot,
} from "./scenarioFixtures";
import { waitForElement, waitForSendButton } from "./dom";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView scripts and worktree integration", () => {
  it("does not leak a server worktree path into drawer runtime env when launch context clears it", async () => {
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
      terminalLaunchContextByThreadId: {
        [THREAD_ID]: { cwd: "/repo/project", worktreePath: null },
      },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: buildWorktreeSnapshot(THREAD_ID),
    });

    try {
      await vi.waitFor(
        () => {
          const openRequest = ctx.wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            cwd: "/repo/project",
            worktreePath: null,
            env: { T3CODE_PROJECT_ROOT: "/repo/project" },
          });
          expect(
            (openRequest as { env?: Record<string, string> } | undefined)?.env
              ?.T3CODE_WORKTREE_PATH,
          ).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T12:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(() => {
        expect(
          ctx.wsRequests.find((request) => request._tag === WS_METHODS.terminalOpen),
        ).toMatchObject({
          _tag: WS_METHODS.terminalOpen,
          threadId: THREAD_ID,
          cwd: "/repo/project",
          env: { T3CODE_PROJECT_ROOT: "/repo/project" },
        });
      });
      await vi.waitFor(() => {
        expect(
          ctx.wsRequests.find((request) => request._tag === WS_METHODS.terminalWrite),
        ).toMatchObject({
          _tag: WS_METHODS.terminalWrite,
          threadId: THREAD_ID,
          data: "bun run lint\r",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T12:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(() => {
        expect(
          ctx.wsRequests.find((request) => request._tag === WS_METHODS.terminalOpen),
        ).toMatchObject({
          _tag: WS_METHODS.terminalOpen,
          threadId: THREAD_ID,
          cwd: "/repo/worktrees/feature-draft",
          env: {
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/feature-draft",
          },
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the server own setup after preparing a pull request worktree thread", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T12:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitResolvePullRequest) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/youpele52/bigbud/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
          };
        }
        if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/youpele52/bigbud/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
            branch: "archive-settings-overhaul",
            worktreePath: "/repo/worktrees/pr-1359",
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "main",
          ) as HTMLButtonElement | null,
        "Unable to find branch selector button.",
      );
      branchButton.click();

      const branchInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches"]'),
        "Unable to find branch search input.",
      );
      branchInput.focus();
      await page.getByPlaceholder("Search branches").fill("1359");

      const checkoutItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Checkout Pull Request",
          ) as HTMLSpanElement | null,
        "Unable to find checkout pull request option.",
      );
      checkoutItem.click();

      const worktreeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Worktree",
          ) as HTMLButtonElement | null,
        "Unable to find Worktree button.",
      );
      worktreeButton.click();

      await vi.waitFor(() => {
        expect(
          ctx.wsRequests.find((request) => request._tag === WS_METHODS.gitPreparePullRequestThread),
        ).toMatchObject({
          _tag: WS_METHODS.gitPreparePullRequestThread,
          cwd: "/repo/project",
          reference: "1359",
          mode: "worktree",
          threadId: THREAD_ID,
        });
      });

      expect(
        ctx.wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite && request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends bootstrap turn-starts and waits for server setup on first-send worktree drafts", async () => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T12:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: 2 };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Ship it");
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(() => {
        expect(
          ctx.wsRequests.find(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ),
        ).toMatchObject({
          _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
          type: "thread.turn.start",
          bootstrap: {
            createThread: { projectId: PROJECT_ID },
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
              branch: expect.stringMatching(/^bigbud\/[0-9a-f]{8}$/),
            },
            runSetupScript: true,
          },
        });
      });

      expect(ctx.wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
      expect(
        ctx.wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite &&
            request.threadId === THREAD_ID &&
            request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });
});
