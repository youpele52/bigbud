import { ORCHESTRATION_WS_METHODS, type OrchestrationReadModel } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../../../../stores/composer";
import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, PROJECT_ID, THREAD_ID } from "./fixtures";
import { waitForElement } from "./dom";
import { createDraftOnlySnapshot } from "./scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

function withRemoteWorkspaceTargets(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const remoteExecutionTargetId = "ssh:host=devbox&user=root&port=22&auth=ssh-key";
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: remoteExecutionTargetId,
      executionTargetId: remoteExecutionTargetId,
    })),
  };
}

describe("ChatView execution target integration", () => {
  it("includes explicit runtime and workspace targets when bootstrapping a remote draft thread", async () => {
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
      snapshot: withRemoteWorkspaceTargets(createDraftOnlySnapshot()),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: 2 };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "map the deployment issue");
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
          bootstrap: {
            createThread: {
              providerRuntimeExecutionTargetId: "local",
              workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
              executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
            },
          },
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
