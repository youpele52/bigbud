import { Deferred, Effect, Fiber, Path } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as devMode from "../../ssh/sshOwnerDevMode.ts";
import { runSshCommand } from "../../ssh/sshProcess.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { makeRemoteGitOps } from "./GitCore.remoteOps.ts";
import {
  DIRECT_WORKSPACE_GIT_LIMITS,
  type DirectWorkspaceGitAction,
  type DirectWorkspaceGitMetadataAction,
  type DirectWorkspaceGitRequest,
} from "./GitCore.ssh.owner.ts";
import { refusedOwnerInputs } from "./GitCore.ssh.owner.testInputs.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

const scope = { executionTargetId: "ssh:host=example&transport=direct-ssh", cwd: "/srv/a repo" };
const statusInput: ExecuteGitInput = {
  ...scope,
  operation: "GitCore.statusDetailsLocal.status",
  args: ["status", "--porcelain=2", "--branch", "-uall"],
  allowNonZeroExit: true,
};
const workTreeInput: ExecuteGitInput = {
  ...scope,
  operation: "GitCore.isInsideWorkTree",
  args: ["rev-parse", "--is-inside-work-tree"],
  allowNonZeroExit: true,
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
};
const success: ExecuteGitResult = {
  code: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

function fixture(result = success) {
  const execute = vi
    .fn<
      (
        request: DirectWorkspaceGitRequest<
          DirectWorkspaceGitAction | DirectWorkspaceGitMetadataAction
        >,
        signal: AbortSignal,
      ) => Promise<ExecuteGitResult>
    >()
    .mockResolvedValue(result);
  const pathRead = vi
    .fn<(request: { readonly path: string }, signal: AbortSignal) => Promise<ExecuteGitResult>>()
    .mockResolvedValue({ ...result, code: 1, stdout: "1\t0\tnew.txt\n" });
  const git = vi.fn(
    makeSshGitExecutor({
      execute,
      statusMetadata: { execute },
      pathRead: { execute: pathRead },
    }),
  );
  const ops = Effect.gen(function* () {
    const path = yield* Path.Path;
    const forTarget = yield* makeRemoteGitOps(git, path, "/unused");
    return yield* forTarget(scope.executionTargetId);
  }).pipe(Effect.provide(Path.layer));
  return { execute, git, ops, pathRead };
}

describe("direct workspace Git owner", () => {
  afterEach(() => {
    expect(runSshCommand).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("maps both real status callers and preserves ordinary non-repository exits", async () => {
    const { execute, ops } = fixture({
      ...success,
      code: 128,
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    });
    const result = await Effect.runPromise(
      ops.pipe(
        Effect.flatMap(({ statusOps }) =>
          Effect.all([statusOps.statusDetailsLocal(scope.cwd), statusOps.statusDetails(scope.cwd)]),
        ),
      ),
    );

    expect(result.map(({ isRepo }) => isRepo)).toEqual([false, false]);
    expect(execute.mock.calls).toEqual([
      [{ ...scope, action: "statusPorcelainV2" }, expect.any(AbortSignal)],
      [{ ...scope, action: "statusPorcelainV2" }, expect.any(AbortSignal)],
    ]);
    expect(DIRECT_WORKSPACE_GIT_LIMITS.statusPorcelainV2).toEqual({
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    });
  });

  it.each([
    { code: 0, stdout: "true\n", inside: true },
    { code: 0, stdout: "false\n", inside: false },
    { code: 128, stdout: "", inside: false },
  ])("maps the real worktree probe for exit $code and stdout $stdout", async (result) => {
    const { execute, ops } = fixture({ ...success, code: result.code, stdout: result.stdout });
    await expect(
      Effect.runPromise(
        ops.pipe(Effect.flatMap(({ worktreeOps }) => worktreeOps.isInsideWorkTree(scope.cwd))),
      ),
    ).resolves.toBe(result.inside);
    expect(execute.mock.calls).toEqual([
      [{ ...scope, action: "isInsideWorkTree" }, expect.any(AbortSignal)],
    ]);
  });

  it.each(["statusDetailsLocal", "statusDetails"] as const)(
    "composes %s from fixed workspace reads for tracked changes",
    async (method) => {
      const { execute, ops } = fixture();
      execute.mockImplementation(async ({ action }) => {
        switch (action) {
          case "statusPorcelainV2":
            return {
              ...success,
              stdout:
                "# branch.head trunk\n# branch.upstream origin/trunk\n# branch.ab +2 -1\n1 MM N... 100644 100644 100644 a b tracked.txt\n",
            };
          case "stagedNumstat":
            return { ...success, stdout: "3\t2\ttracked.txt\n" };
          case "unstagedNumstat":
            return { ...success, stdout: "1\t0\ttracked.txt\n" };
          case "originDefaultRef":
            return { ...success, stdout: "refs/remotes/origin/trunk\n" };
          case "originRemoteUrl":
            return { ...success, stdout: "git@example:repo.git\n" };
          default:
            throw new Error(`Unexpected workspace read: ${action}`);
        }
      });

      await expect(
        Effect.runPromise(
          ops.pipe(Effect.flatMap(({ statusOps }) => statusOps[method](scope.cwd))),
        ),
      ).resolves.toEqual({
        isRepo: true,
        branch: "trunk",
        isDefaultBranch: true,
        hasOriginRemote: true,
        hasUpstream: true,
        upstreamRef: "origin/trunk",
        aheadCount: 2,
        behindCount: 1,
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "tracked.txt", insertions: 4, deletions: 2 }],
          insertions: 4,
          deletions: 2,
        },
      });
      const actions = [
        "statusPorcelainV2",
        "stagedNumstat",
        "unstagedNumstat",
        "originDefaultRef",
        "originRemoteUrl",
      ] as const;
      expect(execute).toHaveBeenCalledTimes(actions.length);
      for (const action of actions) {
        expect(execute).toHaveBeenCalledWith({ ...scope, action }, expect.any(AbortSignal));
        expect(DIRECT_WORKSPACE_GIT_LIMITS[action]).toEqual({
          timeoutMs: 30_000,
          maxOutputBytes: 1_000_000,
        });
      }
    },
  );

  it("keeps missing origin metadata as ordinary Git exits, not failed status", async () => {
    const { execute, ops } = fixture();
    execute.mockImplementation(async ({ action }) => {
      if (action === "statusPorcelainV2") {
        return { ...success, stdout: "# branch.head main\n" };
      }
      if (action === "originDefaultRef" || action === "originRemoteUrl") {
        return { ...success, code: 128, stderr: "fatal: missing origin metadata\n" };
      }
      return success;
    });
    await expect(
      Effect.runPromise(
        ops.pipe(Effect.flatMap(({ statusOps }) => statusOps.statusDetailsLocal(scope.cwd))),
      ),
    ).resolves.toMatchObject({ isRepo: true, hasOriginRemote: false, isDefaultBranch: true });
  });

  const stagedInput: ExecuteGitInput = {
    ...statusInput,
    operation: "GitCore.statusDetailsLocal.stagedNumstat",
    args: ["diff", "--cached", "--numstat"],
  };

  it("fails closed on a metadata read with a proof-only owner", async () => {
    const { execute } = fixture();
    const proofGit = makeSshGitExecutor({ execute });
    await expect(Effect.runPromise(Effect.flip(proofGit(stagedInput)))).resolves.toMatchObject({
      _tag: "GitCommandError",
      operation: stagedInput.operation,
      detail: expect.stringContaining("not supported"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a selected metadata owner's denial in the error channel", async () => {
    const { execute } = fixture();
    const cause = new Error("workspace scope refused");
    const metadata = vi.fn().mockRejectedValueOnce(cause);
    const git = makeSshGitExecutor({ execute, statusMetadata: { execute: metadata } });
    await expect(Effect.runPromise(Effect.flip(git(stagedInput)))).resolves.toMatchObject({
      _tag: "GitCommandError",
      operation: stagedInput.operation,
      cause,
    });
    expect(metadata).toHaveBeenCalledExactlyOnceWith(
      { ...scope, action: "stagedNumstat" },
      expect.any(AbortSignal),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("refreshes selected status when an untracked file appears with one bounded count read", async () => {
    vi.spyOn(devMode, "isDevSshOwnerSelected").mockReturnValue(true);
    const { execute, git, ops, pathRead } = fixture();
    let upstream = "# branch.upstream origin/main\n# branch.ab +2 -1\n";
    let untracked = "";
    execute.mockImplementation(async ({ action }) =>
      action === "statusPorcelainV2"
        ? { ...success, stdout: `# branch.head main\n${upstream}${untracked}` }
        : success,
    );
    await Effect.runPromise(
      ops.pipe(
        Effect.flatMap(({ statusOps }) =>
          Effect.gen(function* () {
            expect(yield* statusOps.status(scope)).toMatchObject({
              hasUpstream: true,
              aheadCount: 2,
              behindCount: 1,
              hasWorkingTreeChanges: false,
            });
            upstream = "";
            untracked = "? new.txt\n";
            expect(yield* statusOps.status(scope)).toMatchObject({
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              hasWorkingTreeChanges: true,
              workingTree: { files: [{ path: "new.txt", insertions: 1, deletions: 0 }] },
            });
          }),
        ),
      ),
    );
    expect(execute).toHaveBeenCalledTimes(10);
    // One extra boundary call is the bounded untracked count, not a metadata read.
    expect(git).toHaveBeenCalledTimes(11);
    expect(pathRead).toHaveBeenCalledExactlyOnceWith(
      {
        action: "untrackedNumstat",
        executionTargetId: scope.executionTargetId,
        cwd: scope.cwd,
        path: "new.txt",
      },
      expect.any(AbortSignal),
    );
  });

  it.each(refusedOwnerInputs(statusInput, workTreeInput))(
    "rejects %s before calling either executor",
    async (_, input) => {
      const { execute, git } = fixture();
      await expect(Effect.runPromise(Effect.flip(git(input)))).resolves.toMatchObject({
        _tag: "GitCommandError",
        operation: input.operation,
        cwd: input.cwd,
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["ENOENT: missing owner endpoint", "workspace scope refused", "owner deadline expired"])(
    "keeps owner failure %s distinct from a non-repository status",
    async (message) => {
      const { execute, ops } = fixture();
      const cause = new Error(message);
      execute.mockRejectedValueOnce(cause);
      const error = await Effect.runPromise(
        ops.pipe(
          Effect.flatMap(({ statusOps }) => statusOps.statusDetailsLocal(scope.cwd)),
          Effect.flip,
        ),
      );
      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: statusInput.operation,
        cause,
        detail: expect.stringContaining("could not complete"),
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["stdoutTruncated", "stderrTruncated"] as const)(
    "rejects an owner result with %s rather than accepting partial data",
    async (stream) => {
      const { git } = fixture({ ...success, [stream]: true });
      await expect(Effect.runPromise(Effect.flip(git(statusInput)))).resolves.toMatchObject({
        _tag: "GitCommandError",
        detail: expect.stringContaining("output limit"),
      });
    },
  );

  it.each([-1, 255, Number.NaN])(
    "rejects %s rather than treating it as a Git exit",
    async (code) => {
      const { git } = fixture({ ...success, code });
      await expect(Effect.runPromise(Effect.flip(git(workTreeInput)))).resolves.toMatchObject({
        _tag: "GitCommandError",
        detail: expect.stringContaining("did not return an ordinary Git exit"),
      });
    },
  );

  it("signals the owner when the caller is interrupted", async () => {
    const { execute, git } = fixture();
    const started = await Effect.runPromise(Deferred.make<AbortSignal>());
    execute.mockImplementationOnce(
      (_, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          Effect.runSync(Deferred.succeed(started, signal));
        }),
    );
    const fiber = Effect.runFork(git(workTreeInput));
    const signal = await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal.aborted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
