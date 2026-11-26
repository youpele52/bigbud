import "../../../index.css";

import { ProjectId, ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { Project, Thread } from "../../../models/types";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";

const mocks = vi.hoisted(() => ({
  api: {
    server: { verifyExecutionTarget: vi.fn(), connectExecutionTarget: vi.fn() },
    orchestration: { dispatchCommand: vi.fn(), getMessageTextChunk: vi.fn() },
  },
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));

import { ThreadRecoveryNotice } from "./ThreadRecoveryNotice";
import { ThreadRemoteTargetNotice } from "./ThreadRemoteTargetNotice";

const SSH = "ssh:host=ice-2-kg&user=root&auth=password";
const PASSWORD_ERROR =
  "SSH password is required for root@ice-2-kg. Re-enter it before using this target.";
const PROJECT_ID = ProjectId.makeUnsafe("project-remote-notice");
const FAILED_AT = "2026-11-21T10:00:00.000Z";
const project = {
  id: PROJECT_ID,
  name: "ice-2-kg",
  cwd: "/srv/app",
  workspaceExecutionTargetId: SSH,
  defaultModelSelection: null,
  scripts: [],
} as unknown as Project;
const thread = {
  id: ThreadId.makeUnsafe("remote-notice-thread"),
  projectId: PROJECT_ID,
  worktreePath: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  turnStartRequest: null,
  messages: [
    { id: "m-1", role: "user", text: "hi", turnId: null, createdAt: FAILED_AT, streaming: false },
  ],
  activities: [
    {
      id: "f-1",
      kind: "provider.turn.start.failed",
      tone: "error",
      summary: "Provider turn start failed",
      turnId: null,
      createdAt: FAILED_AT,
      // A legacy row: classified session-dead before the server fix.
      payload: { failureClass: "session-dead", detail: PASSWORD_ERROR, messageId: "m-1" },
    },
  ],
} as unknown as Thread;

function Notices() {
  return (
    <>
      <ThreadRemoteTargetNotice thread={thread} />
      <ThreadRecoveryNotice thread={thread} onContinueInNewThread={() => undefined} />
    </>
  );
}

describe("ThreadRemoteTargetNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ projects: [project], threads: [thread] });
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    useRemoteAccessStore.getState().clearAuthDialog();
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      disconnectedExecutionTargetIds: {},
      disconnectedTargetsLoaded: true,
      executionTargetChecks: {},
    });
  });
  afterEach(async () => {
    await cleanup();
    document.body.innerHTML = "";
  });

  it("an SSH failure shows the amber notice and never the red Could not reconnect card", async () => {
    await render(<Notices />);
    const notice = page.getByText("ice-2-kg is not connected");
    await expect.element(notice).toBeVisible();
    await expect.element(page.getByText("Your message was not sent.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Enter password" })).toBeVisible();
    expect(page.getByText("Could not reconnect").query()).toBeNull();
    expect(page.getByText(/cannot be resumed/).query()).toBeNull();
    expect(document.querySelector('[data-remote-target-notice="unavailable"]')).not.toBeNull();
  });

  it("Enter password runs one silent check and opens the global prompt only when needed", async () => {
    mocks.api.server.verifyExecutionTarget.mockRejectedValue(new Error(PASSWORD_ERROR));
    await render(<Notices />);
    await page.getByRole("button", { name: "Enter password" }).click();
    await vi.waitFor(() =>
      expect(useRemoteAccessStore.getState().pendingAction?.executionTargetId).toBe(SSH),
    );
    expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledOnce();
  });

  it("offers Resend once access is back, and resends only on click", async () => {
    useRemoteAccessStore.getState().markExecutionTargetVerified(SSH);
    mocks.api.orchestration.dispatchCommand.mockResolvedValue(undefined);
    await render(<Notices />);
    await expect.element(page.getByText("Reconnected to ice-2-kg")).toBeVisible();
    expect(mocks.api.orchestration.dispatchCommand).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Resend" }).click();
    await vi.waitFor(() => expect(mocks.api.orchestration.dispatchCommand).toHaveBeenCalledOnce());
    expect(mocks.api.orchestration.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: thread.id,
      message: { role: "user", text: "hi", attachments: [] },
    });
  });

  it("a user-disconnected workspace shows the read-only banner whose Reconnect connects it", async () => {
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(SSH);
    mocks.api.server.connectExecutionTarget.mockResolvedValue(undefined);
    mocks.api.server.verifyExecutionTarget.mockResolvedValue({ remoteAgent: null });
    await render(<Notices />);
    await expect.element(page.getByText("ice-2-kg is disconnected")).toBeVisible();
    await expect.element(page.getByText(/read-only/)).toBeVisible();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await vi.waitFor(() =>
      expect(mocks.api.server.connectExecutionTarget).toHaveBeenCalledWith({
        executionTargetId: SSH,
      }),
    );
  });
});
