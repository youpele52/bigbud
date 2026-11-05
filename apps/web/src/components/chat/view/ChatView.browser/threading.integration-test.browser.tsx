import { ORCHESTRATION_WS_METHODS, type ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../../../../stores/composer";
import { useStore } from "../../../../stores/main";
import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, PROJECT_ID, THREAD_ID } from "./fixtures";
import { waitForElement } from "./dom";
import { createDraftOnlySnapshot } from "./scenarioFixtures";
import {
  createProjectSnapshotWithThreadCount,
  createReplyThreadSnapshot,
  makeThreadDeletedEvent,
} from "./threading.integration.fixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView threading integration", () => {
  it("shows an explicit empty state for projects without threads in the sidebar", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    try {
      await expect.element(page.getByText("No threads yet")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the project see-more count accurate when cached rows are deleted", async () => {
    const snapshot = createProjectSnapshotWithThreadCount(8);
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await expect.element(page.getByText("See more (4)")).toBeInTheDocument();

      useStore
        .getState()
        .applyOrchestrationEvent(
          makeThreadDeletedEvent("thread-project-overflow-8" as ThreadId, 2),
        );

      await expect.element(page.getByText("See more (3)")).toBeInTheDocument();

      useStore
        .getState()
        .applyOrchestrationEvent(
          makeThreadDeletedEvent("thread-project-overflow-7" as ThreadId, 3),
        );
      await expect.element(page.getByText("See more (3)")).toBeInTheDocument();

      useStore
        .getState()
        .applyOrchestrationEvent(
          makeThreadDeletedEvent("thread-project-overflow-6" as ThreadId, 4),
        );

      await expect.element(page.getByText("See more (3)")).toBeInTheDocument();

      useStore
        .getState()
        .applyOrchestrationEvent(
          makeThreadDeletedEvent("thread-project-overflow-5" as ThreadId, 5),
        );

      await expect.element(page.getByText("See more (3)")).toBeInTheDocument();
      expect(useStore.getState().projects[0]?.activeThreadCount).toBe(4);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the send state once bootstrap dispatch is in flight", async () => {
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

    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) =>
        body._tag === "orchestration.dispatchCommand" ? dispatchPromise : undefined,
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Ship it");
      const sendButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "Unable to find send button.",
      );
      sendButton.click();

      await vi.waitFor(() => {
        expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
        expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeNull();
      });
    } finally {
      resolveDispatch({ sequence: 2 });
      await mounted.cleanup();
    }
  });

  it("sends reply target metadata when replying to an existing message", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createReplyThreadSnapshot(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: 2 };
        }
        return undefined;
      },
    });

    try {
      const replyButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-message-id="msg-assistant-reply-source"] button[aria-label="Reply to message"]',
          ),
        "Unable to find reply button for assistant message.",
      );
      replyButton.click();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.replyTarget).toEqual({
          messageId: "msg-assistant-reply-source",
          role: "assistant",
          createdAt: "2026-03-04T12:00:02.000Z",
          excerpt: "Original assistant answer",
        });
      });
      await waitForElement(
        () =>
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-chat-composer-form="true"] p'),
          ).find((element) => element.textContent?.includes("Original assistant answer")) ?? null,
        "Unable to find composer reply preview excerpt.",
      );

      useComposerDraftStore.getState().setPrompt(THREAD_ID, "follow up reply");
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
          message: {
            replyToMessageId: "msg-assistant-reply-source",
            text: "follow up reply",
          },
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
