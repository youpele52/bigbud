import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SshTargetAuthRequiredError } from "../../ssh/sshTargetUnavailable.ts";
import { assertSshExecutionTargetReadyAsync } from "../../ssh/sshVerification.ts";
import { sshTargetsForSession } from "./ProviderCommandReactorSessionOps.preflight.ts";
import { startProviderSession } from "./ProviderCommandReactorSessionOps.start.ts";
import { classifyTurnStartFailure } from "./ProviderTurnFailureClassification.ts";

vi.mock("../../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: vi.fn(),
}));

const SSH_TARGET = "ssh:host=ice-2-kg&auth=password";
const threadId = ThreadId.makeUnsafe("preflight-thread");

function start(target: string, startSession = vi.fn(() => Effect.void)) {
  const markedStarting = vi.fn();
  const setThreadSession = () => Effect.sync(markedStarting);
  const effect = startProviderSession({
    services: {
      providerService: { startSession } as never,
      setThreadSession,
      assertRuntimeStartAllowed: () => Effect.void,
    },
    thread: {
      id: threadId,
      providerRuntimeExecutionTargetId: target,
      workspaceExecutionTargetId: target,
      executionTargetId: target,
      runtimeMode: "full-access",
    } as OrchestrationThread,
    threadId,
    createdAt: "2026-11-21T00:00:00.000Z",
    provider: "codex",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    cwd: undefined,
  });
  return { effect, startSession, markedStarting };
}

describe("provider session SSH pre-flight", () => {
  beforeEach(() => {
    vi.mocked(assertSshExecutionTargetReadyAsync).mockReset();
  });

  it("lists each distinct SSH target once and skips local targets", () => {
    expect(
      sshTargetsForSession({
        workspaceExecutionTargetId: SSH_TARGET,
        providerRuntimeExecutionTargetId: SSH_TARGET,
      }),
    ).toEqual([SSH_TARGET]);
    expect(
      sshTargetsForSession({
        workspaceExecutionTargetId: "local",
        providerRuntimeExecutionTargetId: "local",
      }),
    ).toEqual([]);
  });

  it("fails before marking the session starting when the SSH target needs a password", async () => {
    vi.mocked(assertSshExecutionTargetReadyAsync).mockRejectedValue(
      new SshTargetAuthRequiredError(SSH_TARGET, "password", "SSH password is required for x."),
    );
    const { effect, startSession, markedStarting } = start(SSH_TARGET);
    const exit = await Effect.runPromiseExit(effect);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(classifyTurnStartFailure(exit.cause)).toBe("auth-or-quota");
    expect(startSession).not.toHaveBeenCalled();
    expect(markedStarting).not.toHaveBeenCalled();
  });

  it("starts normally once the SSH target is ready, and never probes local targets", async () => {
    vi.mocked(assertSshExecutionTargetReadyAsync).mockResolvedValue(undefined);
    const ready = start(SSH_TARGET);
    await Effect.runPromise(ready.effect);
    expect(assertSshExecutionTargetReadyAsync).toHaveBeenCalledWith(SSH_TARGET);
    expect(ready.startSession).toHaveBeenCalledTimes(1);

    vi.mocked(assertSshExecutionTargetReadyAsync).mockClear();
    const local = start("local");
    await Effect.runPromise(local.effect);
    expect(assertSshExecutionTargetReadyAsync).not.toHaveBeenCalled();
    expect(local.startSession).toHaveBeenCalledTimes(1);
  });
});
