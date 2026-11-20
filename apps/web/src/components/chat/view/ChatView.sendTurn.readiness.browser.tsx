import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadProjectGate } from "./ThreadProjectGate";
import {
  SendHarness,
  createSendControl,
  installSendApi,
} from "./ChatView.sendTurn.browser-helpers";
import {
  chatsPage,
  emptyPage,
  otherId,
  otherProjectId,
  resetProjectGateStore,
} from "./ThreadProjectGate.test-helpers";
import { useComposerDraftStore } from "../../../stores/composer";
import { resetComposerDraftStore } from "../../../stores/composer/composer.store.test.utils";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import { resetWsConnectionStateForTests } from "../../../rpc/wsConnectionState";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  localStorage.clear();
  resetProjectGateStore();
  resetComposerDraftStore();
  resetWsConnectionStateForTests();
  useRemoteAccessStore.setState(useRemoteAccessStore.getInitialState(), true);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it.each(["local", "remote"] as const)(
  "loads an omitted arbitrary %s dependency and actually dispatches its follow-up",
  async (scope) => {
    const fixture = await installSendApi();
    const target = scope === "local" ? "local" : "ssh-target";
    const projectPage = {
      ...chatsPage,
      projects: [
        {
          ...chatsPage.projects[0]!,
          id: otherProjectId,
          title: "Arbitrary project",
          workspaceRoot: "/workspace/arbitrary",
          workspaceExecutionTargetId: target,
          executionTargetId: target,
        },
      ],
    };
    useStore.setState((state) => ({
      projects: state.projects.filter((project) => project.id !== otherProjectId),
      threads: state.threads.map((thread) =>
        thread.id === otherId
          ? { ...thread, workspaceExecutionTargetId: target, executionTargetId: target }
          : thread,
      ),
    }));
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    const read = fixture.orchestration.getStartupProjectCatalog;
    read.mockClear();
    read.mockImplementation(async ({ scope: requested }) =>
      requested === scope ? projectPage : emptyPage,
    );
    const control = createSendControl();
    mounted = await render(
      <ThreadProjectGate projectId={otherProjectId}>
        <SendHarness threadId={otherId} control={control} />
      </ThreadProjectGate>,
    );
    await expect.element(mounted.getByRole("button", { name: `Send ${otherId}` })).toBeVisible();
    expect(read.mock.calls).toEqual([
      [{ scope: "local", limit: 1, priorityProjectId: otherProjectId }],
      [{ scope: "remote", limit: 1, priorityProjectId: otherProjectId }],
    ]);
    // A later bounded membership refresh must not evict this mounted surface's dependency.
    useStore
      .getState()
      .syncBoundedCatalog(
        { local: emptyPage, remote: emptyPage },
        {},
        {},
        await fixture.orchestration.getSidebarThreadCatalog(),
        [],
      );
    await vi.waitFor(() => expect(control.input?.activeProject?.id).toBe(otherProjectId));
    await control.onSend();
    expect(fixture.dispatchCommand).toHaveBeenCalledOnce();
    expect(fixture.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: otherId,
        message: expect.objectContaining({ text: "Other thread draft" }),
      }),
    );
    expect(control.input!.activeProject).toMatchObject({
      id: otherProjectId,
      cwd: "/workspace/arbitrary",
      workspaceExecutionTargetId: target,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(useComposerDraftStore.getState().draftsByThreadId[otherId]?.prompt ?? "").toBe("");
  },
);
