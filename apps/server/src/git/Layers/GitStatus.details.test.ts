import { Effect } from "effect";
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
});
