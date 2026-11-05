import { ORCHESTRATION_WS_METHODS, type ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../../../../stores/composer";
import { createChatViewBrowserTestContext } from "./context";
import {
  DEFAULT_VIEWPORT,
  PROJECT_ID,
  THREAD_ID,
  UUID_ROUTE_RE,
  createSnapshotForTargetUser,
} from "./fixtures";
import { waitForComposerEditor, waitForElement, waitForURL } from "./dom";
import { createDraftOnlySnapshot } from "./scenarioFixtures";
import { createPlaceholderThreadSnapshot } from "./threading.integration.fixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView threading drafts integration", () => {
  it("seeds the first-send thread title for local draft threads", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T12:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: 2 };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(
          THREAD_ID,
          "Please investigate reconnect failures after restarting the session.",
        );
      const sendButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "Unable to find send button.",
      );
      sendButton.click();

      await vi.waitFor(() => {
        const turnStartRequest = ctx.wsRequests.find(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        );

        expect(
          ctx.wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.meta.update",
          ),
        ).toBe(false);
        expect(turnStartRequest).toMatchObject({
          _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
          type: "thread.turn.start",
          titleSeed: "Please investigate reconn...",
          bootstrap: {
            createThread: {
              title: "Please investigate reconn...",
            },
          },
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("seeds the first-send thread title for server placeholder threads", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createPlaceholderThreadSnapshot(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: 2 };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "hi");
      const sendButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "Unable to find send button.",
      );
      sendButton.click();

      await vi.waitFor(() => {
        const turnStartRequest = ctx.wsRequests.find(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        );

        expect(turnStartRequest).toMatchObject({
          _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
          type: "thread.turn.start",
          titleSeed: "hi",
        });
        expect(turnStartRequest && "bootstrap" in turnStartRequest).toBe(false);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new thread selected after clicking the new-thread button", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as never,
        targetText: "new thread selection test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await waitForComposerEditor();
      await ctx.promoteDraftThreadViaDomainEvent(newThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after server thread promotion clears the draft.",
      );
      await expect.element(page.getByTestId(`thread-row-${newThreadId}`)).toBeInTheDocument();
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: { reasoningEffort: "medium", fastMode: true },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as never,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: { provider: "codex", model: "gpt-5.3-codex", options: { fastMode: true } },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max", fastMode: true },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as never,
        targetText: "sticky claude model test",
      }),
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: { effort: "max", fastMode: true },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as never,
        targetText: "default codex traits test",
      }),
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: { reasoningEffort: "medium", fastMode: true },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as never,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const threadId = threadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: { provider: "codex", model: "gpt-5.3-codex", options: { fastMode: true } },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low", fastMode: true },
      });

      await page.getByTestId("new-thread-button").click();
      await waitForURL(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.4",
            options: { reasoningEffort: "low", fastMode: true },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
