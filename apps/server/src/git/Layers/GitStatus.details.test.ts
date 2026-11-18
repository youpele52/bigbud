import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import type { ExecuteGitResult } from "../Services/GitCore.ts";
import { makeReadStatusDetails } from "./GitStatus.details.ts";

function result(input: Partial<ExecuteGitResult>): ExecuteGitResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...input,
  };
}

describe("makeReadStatusDetails", () => {
  it("reads fallback numstat for a file that exists only on the execution target", async () => {
    const fallbackCalls: Array<ReadonlyArray<string>> = [];
    const readStatusDetails = makeReadStatusDetails({
      executeGit: (_operation, _cwd, args) => {
        if (args[0] === "status") {
          return Effect.succeed(result({ stdout: "# branch.head main\n? remote-only.txt\n" }));
        }
        if (args.includes("--no-index")) {
          fallbackCalls.push(args);
          return Effect.succeed(result({ code: 1, stdout: "3\t0\tremote-only.txt\n" }));
        }
        return Effect.succeed(result({ code: 1 }));
      },
      runGitStdout: () => Effect.succeed(""),
      originRemoteExists: () => Effect.succeed(false),
      computeAheadCountAgainstBase: () => Effect.succeed(0),
    });

    const details = await Effect.runPromise(
      readStatusDetails("/srv/workspace-that-does-not-exist-locally", "GitCore.statusDetails"),
    );

    expect(fallbackCalls).toEqual([
      ["diff", "--numstat", "--no-index", "/dev/null", "--", "remote-only.txt"],
    ]);
    expect(details.workingTree.files).toEqual([
      { path: "remote-only.txt", insertions: 3, deletions: 0 },
    ]);
  });

  const readStatusForStatusResult = (status: ExecuteGitResult) => {
    const otherCalls: Array<ReadonlyArray<string>> = [];
    const readStatusDetails = makeReadStatusDetails({
      executeGit: (_operation, _cwd, args) => {
        if (args[0] === "status") return Effect.succeed(status);
        otherCalls.push(args);
        return Effect.succeed(result({ code: 1 }));
      },
      runGitStdout: (_operation, _cwd, args) => {
        otherCalls.push(args);
        return Effect.succeed("");
      },
      originRemoteExists: () => Effect.succeed(false),
      computeAheadCountAgainstBase: () => Effect.succeed(0),
    });
    return {
      otherCalls,
      exit: Effect.runSync(
        Effect.exit(readStatusDetails("/home/user/plain-folder", "GitCore.statusDetails")),
      ),
    };
  };

  it.each([
    "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n",
    "fatal: not a git repository (or any of the parent directories): .git\n",
  ])("reports a non-repository folder as a normal state: %s", (stderr) => {
    const { exit, otherCalls } = readStatusForStatusResult(result({ code: 128, stderr }));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Exit.isSuccess(exit) && exit.value.isRepo).toBe(false);
    expect(otherCalls).toEqual([]);
  });

  it.each([
    { code: 128, stderr: "fatal: not a git repository: /srv/app/.git/worktrees/missing\n" },
    { code: 128, stderr: "fatal: detected dubious ownership in repository at '/srv/app'\n" },
    { code: 128, stderr: "fatal: index file smaller than expected\n" },
    { code: 1, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" },
  ])("keeps real git status failures as errors: $stderr", (status) => {
    const { exit } = readStatusForStatusResult(result(status));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain(status.stderr.trim().slice(0, 40));
  });
});
