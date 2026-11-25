import { Effect, Path } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { activateDevSshOwner, isDevSshOwnerSelected } from "../../ssh/sshOwnerDevMode.ts";
import { runSshCommand } from "../../ssh/sshProcess.ts";
import type { ExecuteGitResult } from "../Services/GitCore.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";
import { makeRemoteGitOps } from "./GitCore.remoteOps.ts";
import type {
  DirectWorkspaceGitAction,
  DirectWorkspaceGitMetadataAction,
  DirectWorkspaceGitPathReadRequest,
  DirectWorkspaceGitRequest,
} from "./GitCore.ssh.owner.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";
import { makeUntrackedLineCounter } from "./GitStatus.untrackedCounts.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

const scope = { executionTargetId: "ssh:host=example&transport=direct-ssh", cwd: "/srv/a repo" };
const success: ExecuteGitResult = {
  code: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

function executeGitReturning(byPath: Record<string, ExecuteGitResult>): GitHelpers["executeGit"] {
  return ((_operation: string, _cwd: string, args: readonly string[]) => {
    const path = args.at(-1) ?? "";
    const result = byPath[path];
    return result === undefined
      ? Effect.fail(new Error(`unexpected path ${path}`) as never)
      : Effect.succeed(result);
  }) as GitHelpers["executeGit"];
}

describe("bounded untracked line counts", () => {
  it("returns accurate counts, an explicit binary fallback and a bound", async () => {
    const counter = makeUntrackedLineCounter({
      executeGit: executeGitReturning({
        "new.txt": { ...success, code: 1, stdout: "2\t0\t/dev/null => new.txt\n" },
        "binary.dat": { ...success, code: 1, stdout: "-\t-\t/dev/null => binary.dat\n" },
      }),
      operationPrefix: "GitCore.statusDetailsLocal",
      limit: 2,
    });
    const counts = await Effect.runPromise(
      counter.countUntrackedPaths(scope.cwd, ["new.txt", "binary.dat", "bound.txt"]),
    );
    expect(counts.get("new.txt")).toEqual({ counted: true, insertions: 2, deletions: 0 });
    expect(counts.get("binary.dat")).toEqual({ counted: false, reason: "binary" });
    expect(counts.get("bound.txt")).toEqual({ counted: false, reason: "bound" });
  });

  it("reports an unavailable count instead of fabricating zero", async () => {
    const counter = makeUntrackedLineCounter({
      executeGit: (() =>
        Effect.fail(new Error("owner refused") as never)) as GitHelpers["executeGit"],
      operationPrefix: "GitCore.statusDetailsLocal",
    });
    const counts = await Effect.runPromise(counter.countUntrackedPaths(scope.cwd, ["missing"]));
    expect(counts.get("missing")).toEqual({ counted: false, reason: "unavailable" });
  });
});

describe("selected status untracked counts", () => {
  beforeEach(() => {
    activateDevSshOwner();
  });

  it("reads accurate untracked counts through the bounded owner path", async () => {
    expect(isDevSshOwnerSelected()).toBe(true);
    const pathReads = vi.fn<
      (request: DirectWorkspaceGitPathReadRequest, signal: AbortSignal) => Promise<ExecuteGitResult>
    >(async ({ path }) =>
      path === "new.txt"
        ? { ...success, code: 1, stdout: "2\t1\t/dev/null => new.txt\n" }
        : { ...success, code: 1, stdout: "-\t-\t/dev/null => binary.dat\n" },
    );
    const reads = vi.fn<
      (
        request: DirectWorkspaceGitRequest<
          DirectWorkspaceGitAction | DirectWorkspaceGitMetadataAction
        >,
        signal: AbortSignal,
      ) => Promise<ExecuteGitResult>
    >(async ({ action }) => {
      switch (action) {
        case "statusPorcelainV2":
          return { ...success, stdout: "# branch.head main\n? new.txt\n? binary.dat\n" };
        case "originDefaultRef":
        case "originRemoteUrl":
          return { ...success, code: 128 };
        default:
          return success;
      }
    });
    const git = makeSshGitExecutor({
      execute: reads,
      statusMetadata: { execute: reads },
      pathRead: { execute: pathReads },
    });
    const details = await Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const forTarget = yield* makeRemoteGitOps(git, path, "/unused");
        const ops = yield* forTarget(scope.executionTargetId);
        return yield* ops.statusOps.statusDetailsLocal(scope.cwd);
      }).pipe(Effect.provide(Path.layer)),
    );

    expect(pathReads.mock.calls.map(([request]) => request.path)).toEqual([
      "new.txt",
      "binary.dat",
    ]);
    expect(details.workingTree).toEqual({
      files: [
        { path: "binary.dat", insertions: 0, deletions: 0 },
        { path: "new.txt", insertions: 2, deletions: 1 },
      ],
      insertions: 2,
      deletions: 1,
    });
    expect(pathReads.mock.calls.map(([request]) => request.path)).toEqual([
      "new.txt",
      "binary.dat",
    ]);
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
