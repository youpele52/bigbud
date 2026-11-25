import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { WireWriter } from "../../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readWorkspaceGitResult } from "../../ssh/sshOwnerPickerProof.codec.git.ts";
import { workspaceGitForPickerProof } from "../../ssh/sshOwnerPickerProof.git.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";
import { executeOwnedWorkspaceGit, type DirectWorkspaceGitOwner } from "./GitCore.ssh.owner.ts";

const executionTargetId = "ssh:host=example&transport=direct-ssh";
const cwd = "/srv/a repo";
const mutation: ExecuteGitInput = {
  operation: "GitCore.discardChanges.restore",
  cwd,
  executionTargetId,
  args: ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":(top,literal)a.txt"],
  allowNonZeroExit: true,
  timeoutMs: 30_000,
  operationId: "op-1",
};

describe("selected mutation outcome and cancellation", () => {
  it("decodes an outcome-only result and a normal exit", () => {
    const ambiguous = new WireWriter();
    ambiguous.fieldUint(4, 3);
    expect(readWorkspaceGitResult(ambiguous.finish())).toEqual({
      code: -1,
      stdout: "",
      stderr: "",
      outcome: "outcomeUnknown",
    });
  });

  it("reports an explicit unknown outcome once and never replays", async () => {
    const executeProofWorkspaceGit = vi.fn(async () => ({
      code: -1,
      stdout: "",
      stderr: "",
      outcome: "outcomeUnknown" as const,
    }));
    const port = workspaceGitForPickerProof({ executeProofWorkspaceGit });
    const error = await Effect.runPromise(
      Effect.flip(executeOwnedWorkspaceGit(port, mutation, executionTargetId)),
    );
    expect(error).toMatchObject({ _tag: "GitCommandError" });
    expect(error.detail).toContain("outcome is unknown");
    expect(executeProofWorkspaceGit).toHaveBeenCalledTimes(1);
  });

  it("treats a cancelled owner result as a typed cancellation, not success", async () => {
    const executeProofWorkspaceGit = vi.fn(async () => ({
      code: -1,
      stdout: "",
      stderr: "",
      outcome: "cancelled" as const,
    }));
    const port = workspaceGitForPickerProof({ executeProofWorkspaceGit });
    const error = await Effect.runPromise(
      Effect.flip(executeOwnedWorkspaceGit(port, mutation, executionTargetId)),
    );
    expect(error.detail).toContain("cancelled by its owner lease");
    expect(executeProofWorkspaceGit).toHaveBeenCalledTimes(1);
  });

  it("cancels the single in-flight mutation and does not dispatch a second one", async () => {
    const started = await Effect.runPromise(Deferred.make<AbortSignal>());
    const execute = vi.fn(
      (_request: unknown, signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          Effect.runSync(Deferred.succeed(started, signal));
        }),
    );
    const port: DirectWorkspaceGitOwner = {
      execute: vi.fn(),
      mutation: { execute: execute as never },
    };
    const fiber = Effect.runFork(executeOwnedWorkspaceGit(port, mutation, executionTargetId));
    const signal = await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal.aborted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
