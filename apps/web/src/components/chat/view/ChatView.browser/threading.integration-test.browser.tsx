import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type ThreadId,
} from "@bigbud/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../../../../stores/composer";
import { useStore } from "../../../../stores/main";
import { createChatViewBrowserTestContext } from "./context";
import {
  DEFAULT_VIEWPORT,
  PROJECT_ID,
  THREAD_ID,
  UUID_ROUTE_RE,
  createSnapshotForTargetUser,
} from "./fixtures";
import {
  dispatchCommandPaletteShortcut,
  dispatchSidebarToggleShortcut,
  triggerChatNewShortcutUntilPath,
  waitForComposerEditor,
  waitForElement,
  waitForNewThreadShortcutLabel,
  waitForURL,
} from "./dom";
import { createDraftOnlySnapshot } from "./scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

function makeThreadDeletedEvent(
  threadId: ThreadId,
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.deleted" }> {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-thread-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: `2026-03-04T12:00:0${sequence}.000Z`,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: {
      threadId,
      deletedAt: `2026-03-04T12:00:0${sequence}.000Z`,
    },
  };
}

function createProjectSnapshotWithThreadCount(threadCount: number) {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-project-overflow-target" as never,
    targetText: "project overflow test",
  });

  return {
    ...snapshot,
    threads: Array.from({ length: threadCount }, (_, index) => ({
      ...snapshot.threads[0]!,
      id: `thread-project-overflow-${index + 1}` as ThreadId,
      title: `Project thread ${index + 1}`,
      createdAt: `2026-03-04T12:00:${String(index).padStart(2, "0")}.000Z`,
      updatedAt: `2026-03-04T12:00:${String(index).padStart(2, "0")}.000Z`,
      messages: [],
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      latestTurn: null,
      session: null,
    })),
  };
}

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

  it("updates the project see-more count from the full hidden thread set after deletions", async () => {
    const snapshot = createProjectSnapshotWithThreadCount(8);
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await expect.element(page.getByText("See more (2)")).toBeInTheDocument();

      useStore
        .getState()
        .applyOrchestrationEvent(
          makeThreadDeletedEvent("thread-project-overflow-8" as ThreadId, 2),
        );

      await expect.element(page.getByText("See more (1)")).toBeInTheDocument();

      useStore
        .getState()
        .applyOrchestrationEvent(
          makeThreadDeletedEvent("thread-project-overflow-7" as ThreadId, 3),
        );

      await vi.waitFor(() => {
        expect(document.body.textContent?.includes("See more (")).toBe(false);
      });
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

  it("does not send a client-generated first-send thread title", async () => {
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
        });
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
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeInTheDocument();
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

  it("opens the command palette from mod+k while the composer is focused", async () => {
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
                key: "k",
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
