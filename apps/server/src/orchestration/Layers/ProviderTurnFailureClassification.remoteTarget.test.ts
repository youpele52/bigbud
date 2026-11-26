import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterProcessError } from "../../provider/Errors.ts";
import { RemoteTargetDisconnectedError } from "../../ssh/sshTargetDisconnects.ts";
import {
  buildSshPasswordRequiredMessage,
  SshTargetAuthRequiredError,
} from "../../ssh/sshTargetUnavailable.ts";
import { classifyTurnStartFailure } from "./ProviderTurnFailureClassification.ts";
import { describeRemoteTargetTurnStartFailure } from "./ProviderTurnFailureClassification.remoteTarget.ts";

const TARGET = "ssh:host=ice-2-kg&auth=password";
const processError = (detail: string, cause?: unknown) =>
  new ProviderAdapterProcessError({
    provider: "codex",
    threadId: "thread-1",
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

describe("remote-target turn-start classification", () => {
  it("a process error wrapping an SSH auth-required error is auth-or-quota, not session-dead", () => {
    const error = processError(
      "Failed to prepare Codex remote workspace bridge.",
      new SshTargetAuthRequiredError(
        TARGET,
        "password",
        buildSshPasswordRequiredMessage("ice-2-kg"),
      ),
    );
    expect(classifyTurnStartFailure(error)).toBe("auth-or-quota");
    expect(classifyTurnStartFailure(Cause.fail(error))).toBe("auth-or-quota");
    expect(describeRemoteTargetTurnStartFailure(Cause.fail(error))).toEqual({
      reason: "auth-required",
      executionTargetId: TARGET,
      authMode: "password",
    });
  });

  it("a process error wrapping a user Disconnect is unknown", () => {
    const error = processError("x", new RemoteTargetDisconnectedError(TARGET));
    expect(classifyTurnStartFailure(error)).toBe("unknown");
  });

  it.each([
    [buildSshPasswordRequiredMessage("ice-2-kg"), "auth-or-quota"],
    ["SSH key '~/.ssh/id' requires a passphrase. Load it into ssh-agent.", "auth-or-quota"],
    ['SSH host trust is required: {"challengeId":"c"}', "auth-or-quota"],
    ["Remote workspace is disconnected. Connect it to continue.", "unknown"],
    ["ssh: connect to host box port 22: Operation timed out", "unknown"],
  ])("message-only fallback: %s", (detail, expected) => {
    expect(classifyTurnStartFailure(processError(detail))).toBe(expected);
  });

  it("a plain ECONNRESET process error is still session-dead", () => {
    expect(classifyTurnStartFailure(processError("read ECONNRESET"))).toBe("session-dead");
    expect(describeRemoteTargetTurnStartFailure(processError("read ECONNRESET"))).toBeUndefined();
  });
});
