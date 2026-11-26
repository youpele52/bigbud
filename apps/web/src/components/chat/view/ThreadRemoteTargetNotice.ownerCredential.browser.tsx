import "../../../index.css";

import { ProjectId, ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { Project, Thread } from "../../../models/types";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { RemoteTargetDialogsHost } from "../../remote/RemoteTargetDialogsHost";

const mocks = vi.hoisted(() => ({
  api: {
    server: {
      verifyExecutionTarget: vi.fn(),
      connectExecutionTarget: vi.fn(),
      unlockSshPassword: vi.fn(),
      unlockSshKey: vi.fn(),
      getRemoteAgentRestartStatus: vi.fn(),
    },
    orchestration: { dispatchCommand: vi.fn(), getMessageTextChunk: vi.fn() },
  },
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));

import { ThreadRemoteTargetNotice } from "./ThreadRemoteTargetNotice";

/**
 * The exact texts the server's `credentialPromptFor` (sshOwnerPickerProof.client.credentialPrompt)
 * produces when the SSH owner refuses a non-picker verb (provider start, terminal, Git) with
 * `credential_required`: the destination is the `ssh:` runtime id, and the passphrase text is the
 * owner's "Enter it to unlock this target." variant, not the ssh-agent one.
 */
const SSH = "ssh:host=vm&user=bbcred&port=42995&auth=password";
const OWNER_PASSWORD_ERROR = `SSH password is required for ${SSH}. Re-enter it before using this target.`;
const KEY = "/Users/me/.bigbud-keys/id_ed25519";
const OWNER_PASSPHRASE_ERROR = `SSH key '${KEY}' requires a passphrase. Enter it to unlock this target.`;
const PROJECT_ID = ProjectId.makeUnsafe("project-owner-credential");
const FAILED_AT = "2026-11-20T10:00:00.000Z";

function threadFailingWith(detail: string): Thread {
  return {
    id: ThreadId.makeUnsafe("owner-credential-thread"),
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
        payload: { detail: `Provider start failed: ${detail}`, messageId: "m-1" },
      },
    ],
  } as unknown as Thread;
}

function setup(detail: string) {
  const thread = threadFailingWith(detail);
  const project = {
    id: PROJECT_ID,
    name: "vm",
    cwd: "/home/bbcred/app",
    workspaceExecutionTargetId: SSH,
    defaultModelSelection: null,
    scripts: [],
  } as unknown as Project;
  useStore.setState({ projects: [project], threads: [thread] });
  return render(
    <>
      <RemoteTargetDialogsHost />
      <ThreadRemoteTargetNotice thread={thread} />
    </>,
  );
}

async function expectOneResend() {
  await expect.element(page.getByText("Reconnected to vm")).toBeVisible();
  await page.getByRole("button", { name: "Resend" }).click();
  await vi.waitFor(() => expect(mocks.api.orchestration.dispatchCommand).toHaveBeenCalledOnce());
  expect(mocks.api.orchestration.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
    type: "thread.turn.start",
    message: { role: "user", text: "hi" },
  });
}

describe("ThreadRemoteTargetNotice with an owner credential_required failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    useRemoteAccessStore.getState().clearAuthDialog();
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      disconnectedExecutionTargetIds: {},
      disconnectedTargetsLoaded: true,
      executionTargetChecks: {},
    });
    mocks.api.orchestration.dispatchCommand.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await cleanup();
    document.body.innerHTML = "";
  });

  it("a provider start refused for a password opens the unlock dialog, then resends once", async () => {
    mocks.api.server.verifyExecutionTarget
      .mockRejectedValueOnce(new Error(OWNER_PASSWORD_ERROR))
      .mockResolvedValue({ remoteAgent: null });
    mocks.api.server.unlockSshPassword.mockResolvedValue({ message: "ok" });
    await setup(OWNER_PASSWORD_ERROR);

    await page.getByRole("button", { name: "Enter password" }).click();
    await expect.element(page.getByText("Enter SSH password")).toBeVisible();
    await page.getByPlaceholder("Enter the SSH password").fill("secret");
    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() =>
      expect(mocks.api.server.unlockSshPassword).toHaveBeenCalledWith({
        executionTargetId: SSH,
        password: "secret",
      }),
    );
    await expectOneResend();
    expect(mocks.api.server.unlockSshKey).not.toHaveBeenCalled();
  });

  it("a provider start refused for a key passphrase opens the key dialog, then resends once", async () => {
    mocks.api.server.verifyExecutionTarget
      .mockRejectedValueOnce(new Error(OWNER_PASSPHRASE_ERROR))
      .mockResolvedValue({ remoteAgent: null });
    mocks.api.server.unlockSshKey.mockResolvedValue({ message: "ok" });
    await setup(OWNER_PASSPHRASE_ERROR);

    await page.getByRole("button", { name: "Unlock key" }).click();
    await expect.element(page.getByRole("heading", { name: "Unlock SSH key" })).toBeVisible();
    await page.getByPlaceholder("Enter the SSH key passphrase").fill("phrase");
    await page.getByRole("button", { name: "Unlock SSH key" }).click();
    await vi.waitFor(() =>
      expect(mocks.api.server.unlockSshKey).toHaveBeenCalledWith({
        executionTargetId: SSH,
        passphrase: "phrase",
      }),
    );
    await expectOneResend();
    expect(mocks.api.server.unlockSshPassword).not.toHaveBeenCalled();
  });
});
