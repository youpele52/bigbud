import { ORCHESTRATION_WS_METHODS, ProjectId, WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "../../../../stores/composer";
import { useStore } from "../../../../stores/main";
import { useTerminalStateStore } from "../../../../stores/terminal";
import {
  openTerminalPanel,
  closeTerminalPanel,
} from "../../../../stores/terminal/terminalPanel.coordinator";
import { pendingThreadCreations } from "../../../../lib/threadMaterialization.admission";
import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, NOW_ISO, PROJECT_ID, THREAD_ID } from "./fixtures";
import { createDraftOnlySnapshot } from "./scenarioFixtures";
import { waitForLayout, waitForSendButton } from "./dom";
import { setDraftThreadWithoutWorktree } from "./scenarioFixtures";
import { ensureThreadMaterialized } from "../../../../lib/threadMaterialization";
import * as Effect from "effect/Effect";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

function commands(type: string) {
  return ctx.wsRequests.filter(
    (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && request.type === type,
  );
}

function openBothSurfaces() {
  useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
  useTerminalStateStore
    .getState()
    .ensurePanelTerminal(THREAD_ID, "independent-panel", { open: true });
  openTerminalPanel();
}

describe("real draft materialization through both terminal surfaces", () => {
  it("retains atomic first-send bootstrap when no terminal requested an owner", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Start only on send");
      (await waitForSendButton()).click();
      await vi.waitFor(() => expect(commands("thread.turn.start")).toHaveLength(1));
      expect(commands("thread.turn.start")[0]).toMatchObject({
        threadId: THREAD_ID,
        bootstrap: { createThread: { projectId: PROJECT_ID } },
      });
      expect(commands("thread.create")).toHaveLength(0);
      expect(
        ctx.wsRequests.filter((request) => request._tag === WS_METHODS.terminalOpen),
      ).toHaveLength(0);
      await vi.waitFor(() => expect(ctx.readServerSnapshot().threads[0]?.messages).toHaveLength(1));
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears a failed creation promise and safely retries both surfaces after confirmed rejection", async () => {
    setDraftThreadWithoutWorktree();
    let rejectedCommand: unknown;
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (
          body._tag === ORCHESTRATION_WS_METHODS.getCommandOutcome &&
          rejectedCommand &&
          body.commandId === rejectedCommand
        )
          return {
            commandId: body.commandId,
            status: "rejected",
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            rejectedAt: NOW_ISO,
            resultSequence: 3,
            reason: "other",
            serverEpoch: "browser-test",
            canonicalRevision: 3,
          };
        if (
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          body.type === "thread.create" &&
          !rejectedCommand
        ) {
          rejectedCommand = body.commandId;
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: "Save rejected for retry regression.",
            }),
          );
        }
        return undefined;
      },
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Retain me after failure");
      await expect(ensureThreadMaterialized(THREAD_ID)).rejects.toThrow("rejected");
      await vi.waitFor(() => expect(pendingThreadCreations.has(THREAD_ID)).toBe(false));
      expect(ctx.readServerSnapshot().threads).toHaveLength(0);
      expect(useComposerDraftStore.getState().draftThreadsByThreadId[THREAD_ID]).toBeDefined();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "Retain me after failure",
      );
      openBothSurfaces();
      await vi.waitFor(() =>
        expect(
          ctx.wsRequests.filter((request) => request._tag === WS_METHODS.terminalOpen),
        ).toHaveLength(2),
      );
      expect(commands("thread.create")).toHaveLength(2);
      expect(commands("thread.create")[1]?.commandId).not.toBe(rejectedCommand);
      expect(ctx.readServerSnapshot().threads).toHaveLength(1);
      expect(ctx.readServerSnapshot().threads[0]?.messages).toEqual([]);
      expect(commands("thread.turn.start")).toHaveLength(0);
      expect(pendingThreadCreations.has(THREAD_ID)).toBe(false);
    } finally {
      closeTerminalPanel();
      await mounted.cleanup();
    }
  });

  it.each([
    { scope: "project", concurrentSend: false },
    { scope: "global", concurrentSend: true },
  ])(
    "saves one $scope owner before opening terminals, with concurrent send=$concurrentSend",
    async ({ scope, concurrentSend }) => {
      const global = scope === "global";
      const projectId = global ? ProjectId.makeUnsafe("__chats__") : PROJECT_ID;
      const cwd = global ? "/home/browser/Documents" : "/repo/project";
      const original = createDraftOnlySnapshot();
      const snapshot = {
        ...original,
        projects: original.projects.map((project) =>
          Object.assign({}, project, {
            id: projectId,
            title: global ? "Chats" : project.title,
            workspaceRoot: global ? null : project.workspaceRoot,
          }),
        ),
      };
      useComposerDraftStore.setState({
        draftThreadsByThreadId: {
          [THREAD_ID]: {
            projectId,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
        projectDraftThreadIdByProjectId: { [projectId]: THREAD_ID },
      });
      let release!: () => void;
      let savedWithoutAi = false;
      const creationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const mounted = await ctx.mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture: (fixture) => {
          fixture.welcome = {
            ...fixture.welcome,
            bootstrapProjectId: projectId,
            defaultChatCwd: cwd,
          };
          fixture.serverConfig = {
            ...fixture.serverConfig,
            settings: { ...fixture.serverConfig.settings, defaultChatCwd: cwd },
          };
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && body.type === "thread.create"
            ? creationGate.then(() => {
                const result = ctx.resolveDefaultRpc(body);
                const owner = ctx
                  .readServerSnapshot()
                  .threads.find((thread) => thread.id === THREAD_ID);
                savedWithoutAi =
                  owner?.messages.length === 0 &&
                  owner.session === null &&
                  commands("thread.turn.start").length === 0;
                return result;
              })
            : undefined,
      });
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, "Only send when requested");
        openBothSurfaces();
        await vi.waitFor(() => expect(commands("thread.create")).toHaveLength(1));
        expect(pendingThreadCreations.has(THREAD_ID)).toBe(true);
        expect(
          ctx.wsRequests.filter((request) => request._tag === WS_METHODS.terminalOpen),
        ).toHaveLength(0);
        expect(commands("thread.turn.start")).toHaveLength(0);
        expect(ctx.readServerSnapshot().threads).toHaveLength(0);
        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        if (concurrentSend) {
          sendButton.click();
          // Admission waits on the terminal owner's promise before the send-busy state begins.
          await waitForLayout();
          expect(pendingThreadCreations.has(THREAD_ID)).toBe(true);
          expect(commands("thread.turn.start")).toHaveLength(0);
        }
        release();
        await vi.waitFor(() =>
          expect(
            ctx.wsRequests.filter((request) => request._tag === WS_METHODS.terminalOpen),
          ).toHaveLength(2),
        );
        const opens = ctx.wsRequests.filter((request) => request._tag === WS_METHODS.terminalOpen);
        expect(new Set(opens.map((request) => request.terminalId)).size).toBe(2);
        expect(opens.map((request) => request.threadId)).toEqual([THREAD_ID, THREAD_ID]);
        expect(opens.map((request) => request.cwd)).toEqual([cwd, cwd]);
        expect(opens.map((request) => request.executionTargetId)).toEqual(["local", "local"]);
        expect(commands("thread.create")).toHaveLength(1);
        expect(savedWithoutAi).toBe(true);
        expect(commands("thread.create")[0]).toMatchObject({
          threadId: THREAD_ID,
          projectId,
          workspaceExecutionTargetId: "local",
          providerRuntimeExecutionTargetId: "local",
          executionTargetId: "local",
          worktreePath: null,
        });
        expect(commands("thread.create")[0]).not.toHaveProperty("seedMessages");
        await vi.waitFor(() => expect(pendingThreadCreations.has(THREAD_ID)).toBe(false));
        expect(useComposerDraftStore.getState().draftThreadsByThreadId[THREAD_ID]).toBeUndefined();
        if (!concurrentSend) {
          expect(ctx.readServerSnapshot().threads[0]).toMatchObject({
            id: THREAD_ID,
            projectId,
            messages: [],
            session: null,
          });
          expect(
            useStore.getState().threads.find((thread) => thread.id === THREAD_ID)?.messages,
          ).toEqual([]);
          expect(commands("thread.turn.start")).toHaveLength(0);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "Only send when requested",
          );
          (await waitForSendButton()).click();
        }
        await vi.waitFor(() => expect(commands("thread.turn.start")).toHaveLength(1));
        expect(commands("thread.turn.start")[0]).toMatchObject({ threadId: THREAD_ID });
        expect(
          (commands("thread.turn.start")[0]?.bootstrap as { createThread?: unknown } | undefined)
            ?.createThread,
        ).toBeUndefined();
        expect(commands("thread.create")).toHaveLength(1);
        expect(
          ctx.wsRequests.some(
            (request) =>
              request._tag === WS_METHODS.terminalRestart ||
              request._tag === WS_METHODS.terminalClose,
          ),
        ).toBe(false);
        await expect.poll(() => ctx.readServerSnapshot().threads[0]?.messages.length).toBe(1);
        await vi.waitFor(() =>
          expect(
            useStore.getState().threads.find((thread) => thread.id === THREAD_ID)?.messages,
          ).toHaveLength(1),
        );
        await waitForLayout();
        expect(ctx.wsRequests.some((request) => request._tag === WS_METHODS.terminalWrite)).toBe(
          false,
        );
        expect(document.querySelectorAll(".xterm")).toHaveLength(2);
      } finally {
        release();
        closeTerminalPanel();
        await mounted.cleanup();
      }
    },
  );
});
