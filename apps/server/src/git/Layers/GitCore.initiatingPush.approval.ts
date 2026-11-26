import { realpath } from "node:fs/promises";
import { Effect } from "effect";

import type { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";
import type { InitiatingPushTarget } from "./GitCore.initiatingTransport.ts";
import type { IsolatedInitiatingPushApproval } from "./GitCore.initiatingPush.composition.ts";
import { createGitCommandError } from "./GitCoreUtils.ts";

/**
 * U15 trusted push approval producer. Runs only inside the user-initiated push
 * (`git.runStackedAction`); no provider or agent reaches it. Every value is read from the local
 * repository through the fenced workspace executor, without network:
 *
 * - the expected old OID is the tracking ref `refs/remotes/<remote>/<branch>`, i.e. the remote
 *   state the status UI showed (kept current by owner-mediated background refresh);
 * - the source OID is `HEAD`, the update the user asked to publish.
 *
 * The owner, not this producer, enforces safety: it compares the expected old OID with the live
 * advertisement and admits only that one fast-forward. A wrong value here can only refuse.
 *
 * @module GitCore.initiatingPush.approval
 */

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface PushApprovalInput {
  readonly cwd: string;
  readonly remoteName: string;
  /** The upstream branch name on the remote (no `refs/heads/`). */
  readonly upstreamBranch: string;
  readonly url: string;
  readonly target: InitiatingPushTarget;
  /** First publish: no upstream yet; the expected old OID is all zeros (ref must be absent). */
  readonly publish?: boolean;
}

export const produceInitiatingPushApproval = Effect.fn("produceInitiatingPushApproval")(function* (
  runGitStdout: GitHelpers["runGitStdout"],
  input: PushApprovalInput,
): Effect.fn.Return<IsolatedInitiatingPushApproval, GitCommandError> {
  const fail = (detail: string) =>
    createGitCommandError("GitCore.pushCurrentBranch.approval", input.cwd, ["push"], detail);
  const read = (args: ReadonlyArray<string>) =>
    runGitStdout("GitCore.pushCurrentBranch.approval", input.cwd, [
      "--no-lazy-fetch",
      ...args,
    ]).pipe(Effect.map((stdout) => stdout.trim()));
  const paths = (yield* read([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
  ])).split(/\r?\n/u);
  if (paths.length !== 3) return yield* fail("Could not identify the Git repository.");
  const [worktree, gitDir, commonDir] = yield* Effect.tryPromise({
    try: () => Promise.all(paths.map((path) => realpath(path))),
    catch: () => fail("Could not identify the Git repository."),
  });
  const source = yield* read(["symbolic-ref", "--quiet", "HEAD"]);
  const sourceOid = yield* read(["rev-parse", "--verify", "HEAD^{commit}"]);
  const expectedOldOid = input.publish
    ? "0".repeat(sourceOid.length)
    : yield* read([
        "rev-parse",
        "--verify",
        `refs/remotes/${input.remoteName}/${input.upstreamBranch}^{commit}`,
      ]);
  if (
    !worktree ||
    !gitDir ||
    !commonDir ||
    !source.startsWith("refs/heads/") ||
    !OID.test(sourceOid) ||
    !OID.test(expectedOldOid) ||
    (input.publish === true && source !== `refs/heads/${input.upstreamBranch}`)
  ) {
    return yield* fail("Could not resolve the branch, HEAD or its tracking ref for this push.");
  }
  return {
    direction: "push",
    repository: { worktree, gitDir, commonDir },
    remoteName: input.remoteName,
    refs: {
      source: source as `refs/heads/${string}`,
      destination: `refs/heads/${input.upstreamBranch}`,
    },
    sourceOid,
    ...(input.publish ? { publish: true as const } : {}),
    destinations: [
      {
        effectiveUrl: input.url,
        executionTargetId: input.target.executionTargetId,
        targetGeneration: input.target.targetGeneration,
        endpoint: { ...input.target.endpoint },
        expectedOldOid,
      },
    ],
  };
});
