import { GitCommandError } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  git,
  initRepoWithCommit,
  makeIsolatedGitCore,
  makeTmpDir,
  TestLayer,
} from "./GitCore.test.helpers.ts";
import { GitCore } from "../Services/GitCore.ts";

it.layer(TestLayer)("git integration", (it) => {
  describe("listGitBranches", () => {
    it.effect("lists branches when recency lookup fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const liveGitCore = yield* GitCore;
        let didFailRecency = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (!didFailRecency && input.args[0] === "for-each-ref") {
            didFailRecency = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRecency",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "timeout",
              }),
            );
          }
          return liveGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches[0]?.current).toBe(true);
        expect(didFailRecency).toBe(true);
      }),
    );

    it.effect("falls back to empty remote branch data when remote lookups fail", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);

        const liveGitCore = yield* GitCore;
        let didFailRemoteBranches = false;
        let didFailRemoteNames = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.join(" ") === "branch --no-color --no-column --remotes") {
            didFailRemoteBranches = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteBranches",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          if (input.args.join(" ") === "remote") {
            didFailRemoteNames = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteNames",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          return liveGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.every((branch) => !branch.isRemote)).toBe(true);
        expect(didFailRemoteBranches).toBe(true);
        expect(didFailRemoteNames).toBe(true);
      }),
    );
  });
});
