import { Deferred, Effect, Fiber, Path } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as devMode from "../../ssh/sshOwnerDevMode.fixture.ts";
import { runSshCommand } from "../../ssh/sshProcess.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { makeRemoteGitOps } from "./GitCore.remoteOps.ts";
import type {
  DirectWorkspaceGitAction,
  DirectWorkspaceGitMetadataAction,
  DirectWorkspaceGitMutationRequest,
  DirectWorkspaceGitRequest,
} from "./GitCore.ssh.owner.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

const scope = { executionTargetId: "ssh:host=example&transport=direct-ssh", cwd: "/srv/a repo" };
const success: ExecuteGitResult = {
  code: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const statusPorcelain = [
  "# branch.head main",
  "1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 tracked.txt",
  "? new.txt",
  "",
].join("\n");
const statusPorcelainNul = [
  "1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 tracked.txt",
  "? new.txt",
  "",
].join("\0");

function fixture() {
  const reads =
    vi.fn<
      (
        request: DirectWorkspaceGitRequest<
          DirectWorkspaceGitAction | DirectWorkspaceGitMetadataAction
        >,
        signal: AbortSignal,
      ) => Promise<ExecuteGitResult>
    >();
  const mutation = vi.fn<
    (request: DirectWorkspaceGitMutationRequest, signal: AbortSignal) => Promise<ExecuteGitResult>
  >(async () => success);
  reads.mockImplementation(async ({ action }) => {
    switch (action) {
      case "statusPorcelainV2":
        return { ...success, stdout: statusPorcelain };
      case "statusPorcelainV2Nul":
        return { ...success, stdout: statusPorcelainNul };
      case "unstagedNumstat":
        return { ...success, stdout: "1\t0\ttracked.txt\n" };
      case "stagedNumstat":
        return success;
      case "originDefaultRef":
      case "originRemoteUrl":
        return { ...success, code: 128, stderr: "fatal: missing origin metadata\n" };
      case "showToplevel":
        return { ...success, stdout: `${scope.cwd}\n` };
      default:
        throw new Error(`Unexpected read: ${action}`);
    }
  });
  const git = vi.fn(
    makeSshGitExecutor({
      execute: reads,
      statusMetadata: { execute: reads },
      mutation: { execute: mutation },
    }),
  );
  const ops = Effect.gen(function* () {
    const path = yield* Path.Path;
    const forTarget = yield* makeRemoteGitOps(git, path, "/unused");
    return yield* forTarget(scope.executionTargetId);
  }).pipe(Effect.provide(Path.layer));
  return { git, mutation, ops, reads };
}

describe("selected direct workspace Git mutations", () => {
  beforeEach(() => {
    vi.spyOn(devMode, "isDevSshOwnerSelected").mockReturnValue(true);
  });

  afterEach(() => {
    expect(runSshCommand).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("discards the exact tracked and untracked paths over typed verbs", async () => {
    const { mutation, ops } = fixture();
    await expect(
      Effect.runPromise(
        ops.pipe(
          Effect.flatMap(({ statusOps }) =>
            statusOps.discardChanges(scope.cwd, undefined, "op-1", {
              scope: "paths",
              paths: ["new.txt", "tracked.txt"],
            }),
          ),
        ),
      ),
    ).resolves.toBeUndefined();

    expect(mutation.mock.calls.map(([request]) => request)).toEqual([
      {
        action: "restoreTrackedPaths",
        executionTargetId: scope.executionTargetId,
        cwd: scope.cwd,
        paths: ["tracked.txt"],
        operationId: "op-1:discard.restore.0",
      },
      {
        action: "cleanUntrackedPaths",
        executionTargetId: scope.executionTargetId,
        cwd: scope.cwd,
        paths: ["new.txt"],
        operationId: "op-1:discard.clean.0",
      },
    ]);
  });

  it("stages paths with the fixed add recipe and no caller options", async () => {
    const { git, mutation } = fixture();
    const input: ExecuteGitInput = {
      ...scope,
      operation: "GitCore.stagePaths",
      args: ["add", "--", ":(top,literal)a.txt", ":(top,literal)nested/b.txt"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
      operationId: "op-stage",
    };
    await expect(Effect.runPromise(git(input))).resolves.toEqual(success);
    expect(mutation).toHaveBeenCalledExactlyOnceWith(
      {
        action: "stagePaths",
        executionTargetId: scope.executionTargetId,
        cwd: scope.cwd,
        paths: ["a.txt", "nested/b.txt"],
        operationId: "op-stage",
      },
      expect.any(AbortSignal),
    );
  });

  it.each([
    [
      "a raw option inside the pathspec list",
      {
        ...scope,
        operation: "GitCore.discardChanges.restore",
        args: [
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--force",
          "--",
          ":(top,literal)a.txt",
        ],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      } satisfies ExecuteGitInput,
    ],
    [
      "a path without the literal top prefix",
      {
        ...scope,
        operation: "GitCore.discardChanges.clean",
        args: ["clean", "-f", "-q", "--", "a.txt"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      } satisfies ExecuteGitInput,
    ],
    [
      "a traversal path",
      {
        ...scope,
        operation: "GitCore.discardChanges.clean",
        args: ["clean", "-f", "-q", "--", ":(top,literal)../outside"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      } satisfies ExecuteGitInput,
    ],
    [
      "a caller timeout override",
      {
        ...scope,
        operation: "GitCore.discardChanges.restore",
        args: ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":(top,literal)a.txt"],
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      } satisfies ExecuteGitInput,
    ],
    [
      "a caller environment",
      {
        ...scope,
        operation: "GitCore.discardChanges.clean",
        args: ["clean", "-f", "-q", "--", ":(top,literal)a.txt"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        env: { GIT_SSH_COMMAND: "ambient" },
      } satisfies ExecuteGitInput,
    ],
    [
      "caller stdin",
      {
        ...scope,
        operation: "GitCore.discardChanges.clean",
        args: ["clean", "-f", "-q", "--", ":(top,literal)a.txt"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        stdin: "",
      } satisfies ExecuteGitInput,
    ],
    [
      "a non-absolute workspace root",
      {
        ...scope,
        cwd: "srv/repo",
        operation: "GitCore.discardChanges.clean",
        args: ["clean", "-f", "-q", "--", ":(top,literal)a.txt"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      } satisfies ExecuteGitInput,
    ],
  ])("refuses %s before the owner", async (_, input) => {
    const { git, mutation, reads } = fixture();
    await expect(Effect.runPromise(Effect.flip(git(input)))).resolves.toMatchObject({
      _tag: "GitCommandError",
      operation: input.operation,
      cwd: input.cwd,
    });
    expect(mutation).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it("binds in-flight cancellation to the single mutation dispatch, never a replay", async () => {
    const { git, mutation } = fixture();
    const input: ExecuteGitInput = {
      ...scope,
      operation: "GitCore.discardChanges.restore",
      args: ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":(top,literal)a.txt"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
      operationId: "op-cancel",
    };
    const started = await Effect.runPromise(Deferred.make<AbortSignal>());
    mutation.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          Effect.runSync(Deferred.succeed(started, signal));
        }),
    );
    const fiber = Effect.runFork(git(input));
    const signal = await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal.aborted).toBe(true);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("refuses a mutation when the owner has no typed mutation port", async () => {
    const input: ExecuteGitInput = {
      ...scope,
      operation: "GitCore.discardChanges.restore",
      args: ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":(top,literal)a.txt"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    };
    const git = makeSshGitExecutor({ execute: vi.fn() });
    await expect(Effect.runPromise(Effect.flip(git(input)))).resolves.toMatchObject({
      _tag: "GitCommandError",
      detail: expect.stringContaining("not supported"),
    });
  });
});
