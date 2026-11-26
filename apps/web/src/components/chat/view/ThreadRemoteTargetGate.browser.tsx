import "../../../index.css";

import { ProjectId, ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { resolveRemoteExecutionFailureStatus } from "../../../hooks/useRemoteExecutionAccessGate.shared";
import type { Project, Thread } from "../../../models/types";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import { markRestoredThreadRoute } from "../../../stores/remoteAccess/threadNavigationIntent";
import { RemoteTargetDialogsHost } from "../../remote/RemoteTargetDialogsHost";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  api: {
    server: {
      verifyExecutionTarget: vi.fn(),
      unlockSshPassword: vi.fn(),
      getRemoteAgentRestartStatus: vi.fn(),
    },
    terminal: { open: vi.fn() },
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));

import { ThreadRemoteTargetGate } from "./ThreadRemoteTargetGate";

const SSH = "ssh:host=ice-2-kg&user=root&auth=password";
const PASSWORD_ERROR =
  "SSH password is required for root@ice-2-kg. Re-enter it before using this target.";
const PROJECT_ID = ProjectId.makeUnsafe("project-remote-gate");
const project = {
  id: PROJECT_ID,
  name: "ice-2-kg",
  cwd: "/srv/app",
  workspaceExecutionTargetId: SSH,
  defaultModelSelection: null,
  scripts: [],
} as unknown as Project;
const thread = (id: string, extra: Partial<Thread> = {}) =>
  ({
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    worktreePath: null,
    messages: [],
    activities: [],
    ...extra,
  }) as unknown as Thread;
const THREAD_A = ThreadId.makeUnsafe("remote-gate-a");
const THREAD_B = ThreadId.makeUnsafe("remote-gate-b");

function Gate({ threadId }: { readonly threadId: ThreadId }) {
  return (
    <ThreadRemoteTargetGate threadId={threadId} projectId={PROJECT_ID}>
      <p>Thread body {threadId}</p>
    </ThreadRemoteTargetGate>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const knownDead = () =>
  useRemoteAccessStore
    .getState()
    .setExecutionTargetCheck(SSH, resolveRemoteExecutionFailureStatus("Connection timed out."));

describe("ThreadRemoteTargetGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useStore.setState({ projects: [project], threads: [thread(THREAD_A), thread(THREAD_B)] });
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

  it("auto-reconnects silently on explicit navigation, then opens the thread", async () => {
    knownDead();
    const verify = deferred<{ remoteAgent: null }>();
    mocks.api.server.verifyExecutionTarget.mockReturnValue(verify.promise);
    await render(<Gate threadId={THREAD_A} />);

    await expect.element(page.getByText("Reconnecting to ice-2-kg…")).toBeVisible();
    expect(page.getByText(`Thread body ${THREAD_A}`).query()).toBeNull();
    verify.resolve({ remoteAgent: null });
    await expect.element(page.getByText(`Thread body ${THREAD_A}`)).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: SSH,
      cwd: "/srv/app",
    });
  });

  it("asks for the SSH password only when the silent attempt needs it, then opens", async () => {
    knownDead();
    mocks.api.server.verifyExecutionTarget
      .mockRejectedValueOnce(new Error(PASSWORD_ERROR))
      .mockResolvedValue({ remoteAgent: null });
    mocks.api.server.unlockSshPassword.mockResolvedValue({ message: "ok" });
    await render(
      <>
        <RemoteTargetDialogsHost />
        <Gate threadId={THREAD_A} />
      </>,
    );

    await expect.element(page.getByText("Enter SSH password")).toBeVisible();
    await expect.element(page.getByText("Waiting for password…")).toBeVisible();
    await page.getByPlaceholder("Enter the SSH password").fill("secret");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByText(`Thread body ${THREAD_A}`)).toBeVisible();
    expect(mocks.api.server.unlockSshPassword).toHaveBeenCalledWith({
      executionTargetId: SSH,
      password: "secret",
    });
  });

  it("cancelling the prompt keeps the gate with Enter password", async () => {
    knownDead();
    mocks.api.server.verifyExecutionTarget.mockRejectedValue(new Error(PASSWORD_ERROR));
    await render(
      <>
        <RemoteTargetDialogsHost />
        <Gate threadId={THREAD_A} />
      </>,
    );
    await expect.element(page.getByText("Enter SSH password")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect.element(page.getByText("ice-2-kg needs your SSH password")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Enter password" })).toBeVisible();
    expect(page.getByText(`Thread body ${THREAD_A}`).query()).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("a failed silent attempt shows the error with Reconnect and Go back", async () => {
    knownDead();
    mocks.api.server.verifyExecutionTarget.mockRejectedValue(new Error("Connection timed out."));
    await render(<Gate threadId={THREAD_A} />);

    await expect.element(page.getByText("Could not reach ice-2-kg")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Go back" }).click();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("a startup-restored thread shows the gate without reconnecting until Reconnect", async () => {
    knownDead();
    markRestoredThreadRoute(THREAD_A);
    mocks.api.server.verifyExecutionTarget.mockResolvedValue({ remoteAgent: null });
    await render(<Gate threadId={THREAD_A} />);

    await expect.element(page.getByText("Could not reach ice-2-kg")).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect.element(page.getByText(`Thread body ${THREAD_A}`)).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledOnce();
  });

  it("two threads of one workspace share one reconnect attempt", async () => {
    knownDead();
    const verify = deferred<{ remoteAgent: null }>();
    mocks.api.server.verifyExecutionTarget.mockReturnValue(verify.promise);
    await render(
      <>
        <Gate threadId={THREAD_A} />
        <Gate threadId={THREAD_B} />
      </>,
    );
    await expect.element(page.getByText("Reconnecting to ice-2-kg…").first()).toBeVisible();
    verify.resolve({ remoteAgent: null });
    await expect.element(page.getByText(`Thread body ${THREAD_A}`)).toBeVisible();
    await expect.element(page.getByText(`Thread body ${THREAD_B}`)).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledOnce();
  });

  it("waits on a password prompt already pending for the same target", async () => {
    useRemoteAccessStore
      .getState()
      .setExecutionTargetCheck(SSH, resolveRemoteExecutionFailureStatus(PASSWORD_ERROR));
    useRemoteAccessStore.getState().openAuthDialog({
      pendingAction: { executionTargetId: SSH, onVerified: () => undefined },
      authMode: "password",
      promptLabel: "root@ice-2-kg",
    });
    await render(<Gate threadId={THREAD_A} />);
    await expect.element(page.getByText("Waiting for password…")).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).not.toHaveBeenCalled();
  });

  it("opens an unknown target at once and verifies it in the background", async () => {
    mocks.api.server.verifyExecutionTarget.mockResolvedValue({ remoteAgent: null });
    await render(<Gate threadId={THREAD_A} />);
    await expect.element(page.getByText(`Thread body ${THREAD_A}`)).toBeVisible();
    await vi.waitFor(() => expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledOnce());
  });

  it("opens a user-disconnected workspace read-only without connecting", async () => {
    knownDead();
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(SSH);
    await render(<Gate threadId={THREAD_A} />);
    await expect.element(page.getByText(`Thread body ${THREAD_A}`)).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).not.toHaveBeenCalled();
  });

  it("a newer SSH failure on the thread invalidates a stale verified flag", async () => {
    useRemoteAccessStore.getState().markExecutionTargetVerified(SSH);
    const later = new Date(Date.now() + 60_000).toISOString();
    useStore.setState({
      threads: [
        thread(THREAD_A, {
          messages: [
            {
              id: "m-1",
              role: "user",
              text: "hi",
              turnId: null,
              createdAt: later,
              streaming: false,
            },
          ],
          activities: [
            {
              id: "f-1",
              kind: "provider.turn.start.failed",
              tone: "error",
              summary: "Provider turn start failed",
              turnId: null,
              createdAt: later,
              payload: { failureClass: "session-dead", detail: PASSWORD_ERROR, messageId: "m-1" },
            },
          ],
        } as unknown as Partial<Thread>),
      ],
    });
    mocks.api.server.verifyExecutionTarget.mockRejectedValue(new Error(PASSWORD_ERROR));
    await render(<Gate threadId={THREAD_A} />);
    // The one silent attempt still needs the password, so the global prompt is now pending.
    await expect.element(page.getByText("Waiting for password…")).toBeVisible();
    expect(mocks.api.server.verifyExecutionTarget).toHaveBeenCalledOnce();
    expect(useRemoteAccessStore.getState().pendingAction?.executionTargetId).toBe(SSH);
  });
});
