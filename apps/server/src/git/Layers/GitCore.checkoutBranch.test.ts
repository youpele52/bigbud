import path from "node:path";

import { GitCommandError } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  configureRemote,
  git,
  initRepoWithCommit,
  makeIsolatedGitCore,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";
import { GitCore } from "../Services/GitCore.ts";

it.layer(TestLayer)("git integration", (it) => {
  describe("checkoutGitBranch", () => {
    it.effect("checks out an existing branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature" });

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature");
      }),
    );

    it.effect("coalesces upstream refreshes across sibling worktrees on the same remote", () =>
      Effect.gen(function* () {
        const ok = (stdout = "") =>
          Effect.succeed({
            code: 0,
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });

        let fetchCount = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (
            input.args[0] === "rev-parse" &&
            input.args[1] === "--abbrev-ref" &&
            input.args[2] === "--symbolic-full-name" &&
            input.args[3] === "@{upstream}"
          ) {
            return ok(
              input.cwd === "/repo/worktrees/pr-123" ? "origin/feature/pr-123\n" : "origin/main\n",
            );
          }
          if (input.args[0] === "remote") {
            return ok("origin\n");
          }
          if (input.args[0] === "rev-parse" && input.args[1] === "--git-common-dir") {
            return ok("/repo/.git\n");
          }
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            fetchCount += 1;
            expect(input.cwd).toBe("/repo");
            expect(input.args).toEqual([
              "--git-dir",
              "/repo/.git",
              "fetch",
              "--quiet",
              "--no-tags",
              "origin",
            ]);
            return ok();
          }
          if (input.operation === "GitCore.statusDetails.status") {
            return ok(
              input.cwd === "/repo/worktrees/pr-123"
                ? "# branch.head feature/pr-123\n# branch.upstream origin/feature/pr-123\n# branch.ab +0 -0\n"
                : "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n",
            );
          }
          if (
            input.operation === "GitCore.statusDetails.unstagedNumstat" ||
            input.operation === "GitCore.statusDetails.stagedNumstat"
          ) {
            return ok();
          }
          if (input.operation === "GitCore.statusDetails.defaultRef") {
            return ok("refs/remotes/origin/main\n");
          }
          return Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: `git ${input.args.join(" ")}`,
              cwd: input.cwd,
              detail: "Unexpected git command in coalesced refresh cache test.",
            }),
          );
        });

        yield* core.statusDetails("/repo/worktrees/main");
        yield* core.statusDetails("/repo/worktrees/pr-123");
        expect(fetchCount).toBe(1);
      }),
    );

    it.effect(
      "briefly backs off failed upstream refreshes across sibling worktrees on one remote",
      () =>
        Effect.gen(function* () {
          const ok = (stdout = "") =>
            Effect.succeed({
              code: 0,
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });

          let fetchCount = 0;
          const core = yield* makeIsolatedGitCore((input) => {
            if (
              input.args[0] === "rev-parse" &&
              input.args[1] === "--abbrev-ref" &&
              input.args[2] === "--symbolic-full-name" &&
              input.args[3] === "@{upstream}"
            ) {
              return ok("origin/main\n");
            }
            if (input.args[0] === "remote") {
              return ok("origin\n");
            }
            if (input.args[0] === "rev-parse" && input.args[1] === "--git-common-dir") {
              return ok("/repo/.git\n");
            }
            if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
              fetchCount += 1;
              return Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "simulated fetch timeout",
                }),
              );
            }
            if (input.operation === "GitCore.statusDetails.status") {
              return ok("# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n");
            }
            if (
              input.operation === "GitCore.statusDetails.unstagedNumstat" ||
              input.operation === "GitCore.statusDetails.stagedNumstat"
            ) {
              return ok();
            }
            if (input.operation === "GitCore.statusDetails.defaultRef") {
              return ok("refs/remotes/origin/main\n");
            }
            return Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "Unexpected git command in refresh failure cooldown test.",
              }),
            );
          });

          yield* core.statusDetails("/repo/worktrees/main");
          yield* core.statusDetails("/repo/worktrees/pr-123");
          expect(fetchCount).toBe(1);
        }),
    );

    it.effect("throws when branch does not exist", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "nonexistent" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("does not silently checkout a local branch when a remote ref no longer exists", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: source, branch: "feature" });

        const checkoutResult = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: source, branch: "origin/feature" }),
        );
        expect(checkoutResult._tag).toBe("Failure");
        expect(yield* git(source, ["branch", "--show-current"])).toBe(defaultBranch);
      }),
    );

    it.effect("checks out a remote tracking branch when remote name contains slashes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const prefixRemote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const prefixFetchNamespace = "prefix-my-org";
        const prefixRemoteName = "my-org";
        const remoteName = "my-org/upstream";
        const featureBranch = "feature";
        yield* git(remote, ["init", "--bare"]);
        yield* git(prefixRemote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* configureRemote(source, prefixRemoteName, prefixRemote, prefixFetchNamespace);
        yield* configureRemote(source, remoteName, remote, remoteName);
        yield* git(source, ["push", "-u", remoteName, defaultBranch]);

        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature content\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature commit"]);
        yield* git(source, ["push", "-u", remoteName, featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);
        yield* git(source, ["branch", "-D", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({
          cwd: source,
          branch: `${remoteName}/${featureBranch}`,
        });

        expect(yield* git(source, ["branch", "--show-current"])).toBe("upstream/feature");
        const realGitCore = yield* GitCore;
        let fetchArgs: readonly string[] | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            fetchArgs = [...input.args];
            return Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          return realGitCore.execute(input);
        });

        const status = yield* core.statusDetails(source);
        expect(status.branch).toBe("upstream/feature");
        expect(status.upstreamRef).toBe(`${remoteName}/${featureBranch}`);
        expect(fetchArgs).toEqual([
          "--git-dir",
          path.join(source, ".git"),
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
        ]);
      }),
    );

    it.effect(
      "falls back to detached checkout when --track would conflict with an existing local branch",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const defaultBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", defaultBranch]);

          yield* git(source, ["branch", "--unset-upstream"]);

          yield* (yield* GitCore).checkoutBranch({
            cwd: source,
            branch: `origin/${defaultBranch}`,
          });

          const core = yield* GitCore;
          const status = yield* core.statusDetails(source);
          expect(status.branch).toBeNull();
        }),
    );

    it.effect("throws when checkout would overwrite uncommitted changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "other" });

        yield* writeTextFile(path.join(tmp, "README.md"), "modified\n");
        yield* git(tmp, ["add", "README.md"]);

        yield* git(tmp, ["stash"]);
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" });
        yield* writeTextFile(path.join(tmp, "README.md"), "other content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "other change"]);

        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => !b.current,
        )!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });

        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting local\n");

        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });
});
