import { describe, expect, it } from "vitest";

import { ProviderAdapterProcessError } from "../provider/Errors.ts";
import {
  assertSshPasswordExecutionTargetReady,
  formatSshPasswordRequiredMessage,
} from "./sshSession.ts";
import { RemoteTargetDisconnectedError } from "./sshTargetDisconnects.ts";
import {
  describeRemoteTargetUnavailable,
  isRemoteTargetUnavailable,
  SshTargetAuthRequiredError,
} from "./sshTargetUnavailable.ts";
import { formatSshKeyLoadMessage } from "./sshVerification.ts";

const PASSWORD_TARGET = "ssh:host=ice-2-kg&user=root&auth=password";

describe("SSH target unavailable errors", () => {
  it("throws a typed password error with the unchanged message text", () => {
    let thrown: unknown;
    try {
      assertSshPasswordExecutionTargetReady(PASSWORD_TARGET);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SshTargetAuthRequiredError);
    expect(thrown).toMatchObject({
      executionTargetId: PASSWORD_TARGET,
      authMode: "password",
      message: "SSH password is required for root@ice-2-kg. Re-enter it before using this target.",
    });
  });

  it("keeps the key passphrase message text", () => {
    expect(formatSshKeyLoadMessage("~/.ssh/id_ed25519")).toBe(
      "SSH key '~/.ssh/id_ed25519' requires a passphrase. Load it into ssh-agent with 'ssh-add ~/.ssh/id_ed25519' before using this target.",
    );
  });

  it("walks the adapter cause chain to the typed error", () => {
    const wrapped = new ProviderAdapterProcessError({
      provider: "codex",
      threadId: "thread-1",
      detail: "Failed to prepare Codex remote workspace bridge.",
      cause: new SshTargetAuthRequiredError(PASSWORD_TARGET, "password", "anything"),
    });
    expect(describeRemoteTargetUnavailable(wrapped)).toEqual({
      reason: "auth-required",
      executionTargetId: PASSWORD_TARGET,
      authMode: "password",
    });
    expect(
      describeRemoteTargetUnavailable(
        new ProviderAdapterProcessError({
          provider: "claudeAgent",
          threadId: "thread-1",
          detail: "x",
          cause: new RemoteTargetDisconnectedError(PASSWORD_TARGET),
        }),
      ),
    ).toEqual({ reason: "disconnected", executionTargetId: PASSWORD_TARGET });
  });

  it.each([
    [
      formatSshPasswordRequiredMessage(PASSWORD_TARGET),
      { reason: "auth-required", authMode: "password" },
    ],
    [
      formatSshKeyLoadMessage("~/.ssh/id"),
      { reason: "auth-required", authMode: "ssh-key-passphrase" },
    ],
    [
      'SSH host trust is required: {"challengeId":"c"}',
      { reason: "auth-required", authMode: "host-trust" },
    ],
    ["Remote workspace is disconnected. Connect it to continue.", { reason: "disconnected" }],
    ["ssh: connect to host box port 22: Connection refused", { reason: "unreachable" }],
    [
      "ssh: Could not resolve hostname box: nodename nor servname provided",
      { reason: "unreachable" },
    ],
  ])("recognises a flattened message: %s", (detail, expected) => {
    const flattened = new ProviderAdapterProcessError({
      provider: "opencode",
      threadId: "thread-1",
      detail: `Failed to start session: ${detail}`,
    });
    expect(describeRemoteTargetUnavailable(flattened)).toEqual(expected);
  });

  it("does not match ordinary dead-session failures", () => {
    expect(isRemoteTargetUnavailable(new Error("read ECONNRESET"))).toBe(false);
    expect(isRemoteTargetUnavailable(new Error("connect ECONNREFUSED 127.0.0.1:4096"))).toBe(false);
    expect(isRemoteTargetUnavailable(undefined)).toBe(false);
  });
});
