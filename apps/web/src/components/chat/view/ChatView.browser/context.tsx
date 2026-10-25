import "../../../../index.css";

import {
  BUILT_IN_CHATS_PROJECT_ID,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ThreadId,
} from "@bigbud/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/settings";
import { closeTerminalPanel } from "../../../../stores/terminal/terminalPanel.coordinator";
import { useCommandPaletteStore } from "../../../../stores/ui";

import { __resetNativeApiForTests } from "../../../../rpc/nativeApi";
import { __resetWsRpcClientForTests } from "../../../../rpc/wsRpcClient";
import { getRouter } from "../../../../config/router";
import { useStore } from "../../../../stores/main";
import { useComposerDraftStore } from "../../../../stores/composer";
import { useTerminalStateStore } from "../../../../stores/terminal";
import { forgetTerminalLaunch } from "../../../../lib/terminalLaunchBinding";
import { admitThreadCreationForSend } from "../../../../lib/threadMaterialization.admission";
import {
  BrowserWsRpcHarness,
  type NormalizedWsRpcRequestBody,
} from "../../../../../test/wsRpcHarness";
import { measureUserRow, setViewport, waitForLayout, waitForProductionStyles } from "./dom";
import { createTerminalOwnershipRpcFixture } from "./context.terminalOwnership";
import { resolveCatalogRpc, withBuiltInChatsProject } from "./context.catalog";
import { publishProjectMetadata } from "./context.projectMetadata";
import {
  ATTACHMENT_SVG,
  DEFAULT_VIEWPORT,
  THREAD_ID,
  type MountedChatView,
  type TestFixture,
  type ViewportSpec,
  addThreadToSnapshot,
  buildFixture,
  createSnapshotForTargetUser,
  createThreadCreatedEvent,
} from "./fixtures";

export function createChatViewBrowserTestContext() {
  let fixture = buildFixture(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-bootstrap" as MessageId,
      targetText: "bootstrap",
    }),
  );
  const rpcHarness = new BrowserWsRpcHarness();
  const wsRequests = rpcHarness.requests;
  const terminalOwnership = createTerminalOwnershipRpcFixture({
    readSnapshot: () => fixture.snapshot,
    writeSnapshot: (snapshot) => {
      fixture.snapshot = snapshot;
    },
    emitEvent: (event) =>
      rpcHarness.emitStreamValue(WS_METHODS.subscribeOrchestrationDomainEvents, event),
  });
  let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null =
    null;
  const wsLink = ws.link(/ws(s)?:\/\/.*/);
  const worker = setupWorker(
    wsLink.addEventListener("connection", ({ client }) => {
      void rpcHarness.connect(client);
      client.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          void rpcHarness.onMessage(event.data, client);
        }
      });
    }),
    http.get("*/attachments/:attachmentId", () =>
      HttpResponse.text(ATTACHMENT_SVG, { headers: { "Content-Type": "image/svg+xml" } }),
    ),
    http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
  );

  function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
    const customResult = customWsRpcResolver?.(body);
    if (customResult !== undefined) {
      return customResult;
    }
    return resolveDefaultRpc(body);
  }

  function resolveDefaultRpc(body: NormalizedWsRpcRequestBody): unknown {
    // Legacy snapshots are scoped to the selected project; loading Chats expands that projection.
    if (
      body._tag === ORCHESTRATION_WS_METHODS.getStartupProjectCatalog &&
      body.priorityProjectId === BUILT_IN_CHATS_PROJECT_ID
    )
      fixture.snapshot = withBuiltInChatsProject(fixture.snapshot);
    const ownershipResult = terminalOwnership.resolve(body);
    if (ownershipResult !== undefined) return ownershipResult;
    const catalogResult = resolveCatalogRpc(body, fixture.snapshot);
    if (catalogResult !== undefined) return catalogResult;
    if (body._tag === ORCHESTRATION_WS_METHODS.getSnapshot) return fixture.snapshot;
    if (body._tag === WS_METHODS.serverGetConfig) return fixture.serverConfig;
    if (body._tag === WS_METHODS.serverPing) return { serverTime: fixture.snapshot.updatedAt };
    if (body._tag === WS_METHODS.gitListBranches) {
      return {
        isRepo: true,
        hasOriginRemote: true,
        nextCursor: null,
        totalCount: 1,
        branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
      };
    }
    if (body._tag === WS_METHODS.gitRefreshStatus) {
      return {
        isRepo: true,
        hasOriginRemote: true,
        isDefaultBranch: true,
        branch: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      };
    }
    if (body._tag === WS_METHODS.projectsSearchEntries) {
      return { entries: [], truncated: false };
    }
    if (body._tag === WS_METHODS.shellOpenInEditor) return null;
    if (body._tag === WS_METHODS.terminalOpen) {
      return {
        threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
        terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
        executionTargetId:
          typeof body.executionTargetId === "string" ? body.executionTargetId : "local",
        runtimeEnv: body.env ?? {},
        dropPathMode: "posix",
        cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
        worktreePath: typeof body.worktreePath === "string" ? body.worktreePath : null,
        status: "running",
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: fixture.welcome.cwd,
      };
    }
    return {};
  }

  async function waitForWsClient(): Promise<void> {
    await vi.waitFor(
      () => {
        expect(
          wsRequests.some(
            (request) => request._tag === WS_METHODS.subscribeOrchestrationDomainEvents,
          ),
        ).toBe(true);
      },
      { timeout: 8_000, interval: 16 },
    );
  }

  async function promoteDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
    await waitForWsClient();
    fixture.snapshot = addThreadToSnapshot(fixture.snapshot, threadId);
    rpcHarness.emitStreamValue(
      WS_METHODS.subscribeOrchestrationDomainEvents,
      createThreadCreatedEvent(threadId, fixture.snapshot.snapshotSequence),
    );
    await vi.waitFor(
      () => {
        expect(useComposerDraftStore.getState().draftThreadsByThreadId[threadId]).toBeUndefined();
      },
      { timeout: 8_000, interval: 16 },
    );
  }

  async function mountChatView(options: {
    viewport: ViewportSpec;
    snapshot: OrchestrationReadModel;
    configureFixture?: (fixture: TestFixture) => void;
    resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
  }): Promise<MountedChatView> {
    fixture = buildFixture(options.snapshot);
    options.configureFixture?.(fixture);
    customWsRpcResolver = options.resolveRpc ?? null;
    await setViewport(options.viewport);
    await waitForProductionStyles();

    const host = document.createElement("div");
    Object.assign(host.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      display: "grid",
      overflow: "hidden",
    });
    document.body.append(host);

    const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_ID}`] }));
    const screen = await render(<RouterProvider router={router} />, { container: host });
    await vi.waitFor(() => expect(useStore.getState().bootstrapComplete).toBe(true), {
      timeout: 8_000,
    });
    await waitForLayout();
    await publishProjectMetadata({
      readSnapshot: () => fixture.snapshot,
      writeSnapshot: (snapshot) => {
        fixture.snapshot = snapshot;
      },
      emitEvent: (event) =>
        rpcHarness.emitStreamValue(WS_METHODS.subscribeOrchestrationDomainEvents, event),
    });
    await waitForLayout();

    const cleanup = async () => {
      customWsRpcResolver = null;
      await screen.unmount();
      host.remove();
    };

    return {
      [Symbol.asyncDispose]: cleanup,
      cleanup,
      measureUserRow: async (targetMessageId: MessageId) =>
        measureUserRow({ host, targetMessageId }),
      setViewport: async (viewport) => {
        await setViewport(viewport);
        await waitForProductionStyles();
      },
      setContainerSize: async (viewport) => {
        host.style.width = `${viewport.width}px`;
        host.style.height = `${viewport.height}px`;
        await waitForLayout();
      },
      router,
    };
  }

  async function measureUserRowAtViewport(options: {
    snapshot: OrchestrationReadModel;
    targetMessageId: MessageId;
    viewport: ViewportSpec;
  }) {
    const mounted = await mountChatView({ viewport: options.viewport, snapshot: options.snapshot });
    try {
      return await mounted.measureUserRow(options.targetMessageId);
    } finally {
      await mounted.cleanup();
    }
  }

  async function waitForServerConfigToApply(): Promise<void> {
    await vi.waitFor(
      () => {
        expect(
          wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig),
        ).toBe(true);
      },
      { timeout: 8_000, interval: 16 },
    );
    await waitForLayout();
  }

  function registerLifecycleHooks(): void {
    beforeAll(async () => {
      await worker.start({
        onUnhandledRequest: "bypass",
        quiet: true,
        serviceWorker: { url: "/mockServiceWorker.js" },
      });
    });

    afterAll(async () => {
      await rpcHarness.disconnect();
      await worker.stop();
    });

    beforeEach(async () => {
      await rpcHarness.reset({
        resolveUnary: resolveWsRpc,
        getInitialStreamValues: (request) => {
          if (request._tag === WS_METHODS.subscribeServerLifecycle) {
            return [{ version: 1, sequence: 1, type: "welcome", payload: fixture.welcome }];
          }
          if (request._tag === WS_METHODS.subscribeServerConfig) {
            return [{ version: 1, type: "snapshot", config: fixture.serverConfig }];
          }
          if (request._tag === WS_METHODS.subscribeOrchestrationDomainEvents)
            return [
              {
                type: "lifecycle",
                route: "direct-unmanaged",
                consumerId: request.consumerId,
                consumerGeneration: 0,
                state: "live",
                acknowledgedSequence: request.appliedSequence ?? 0,
                restartAttempt: 0,
              },
            ];
          return [];
        },
      });
      await __resetWsRpcClientForTests();
      await __resetNativeApiForTests();
      await setViewport(DEFAULT_VIEWPORT);
      localStorage.clear();
      localStorage.setItem(
        "bigbud:client-settings:v1",
        JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, hasSeenFileAccessPrompt: true }),
      );
      document.body.innerHTML = "";
      wsRequests.length = 0;
      terminalOwnership.reset();
      closeTerminalPanel();
      useCommandPaletteStore.setState({ open: false });
      // Each case resets the fake server, so retained launch/owner confirmations must reset too.
      for (const [threadId, state] of Object.entries(
        useTerminalStateStore.getState().terminalStateByThreadId,
      )) {
        for (const terminalId of state.terminalIds) forgetTerminalLaunch(threadId, terminalId);
      }
      for (const [threadId, state] of Object.entries(
        useTerminalStateStore.getState().panelTerminalStateByThreadId,
      )) {
        for (const terminalId of state.terminalIds) forgetTerminalLaunch(threadId, terminalId);
      }
      await admitThreadCreationForSend(THREAD_ID, false);
      customWsRpcResolver = null;
      useComposerDraftStore.setState({
        draftsByThreadId: {},
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModelSelectionByProvider: {},
        stickyActiveProvider: null,
      });
      useStore.setState({
        projects: [],
        threads: [],
        sidebarThreadsById: {},
        threadIdsByProjectId: {},
        threadSummaryCursorByProjectId: {},
        sidebarRecentThreadIds: [],
        sidebarPinnedThreadIds: [],
        threadHydrationById: {},
        latestProjectEventSequenceById: {},
        bootstrapComplete: false,
      });
      useTerminalStateStore.persist.clearStorage();
      useTerminalStateStore.setState({
        terminalStateByThreadId: {},
        panelTerminalStateByThreadId: {},
        terminalLaunchContextByThreadId: {},
        terminalEventEntriesByKey: {},
        nextTerminalEventId: 1,
      });
    });

    afterEach(() => {
      customWsRpcResolver = null;
      document.body.innerHTML = "";
    });
  }

  return {
    resolveDefaultRpc,
    readServerSnapshot: () => fixture.snapshot,
    wsRequests,
    mountChatView,
    measureUserRowAtViewport,
    promoteDraftThreadViaDomainEvent,
    registerLifecycleHooks,
    waitForServerConfigToApply,
  };
}
