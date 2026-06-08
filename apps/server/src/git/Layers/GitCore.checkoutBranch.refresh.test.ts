import path from "node:path";

import { GitCommandError } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, vi } from "vitest";

import {
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
    it.effect("refreshes upstream behind count after checkout when remote branch advanced", () =>
      Effect.gen(function* () {
        const services = yield* Effect.services();
        const runPromise = Effect.runPromiseWith(services);

        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-behind";
        yield* (yield* GitCore).createBranch({ cwd: source, branch: featureBranch });
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: defaultBranch });

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-b", featureBranch, "--track", `origin/${featureBranch}`]);
        yield* writeTextFile(path.join(clone, "feature.txt"), "feature from remote\n");
        yield* git(clone, ["add", "feature.txt"]);
        yield* git(clone, ["commit", "-m", "remote feature update"]);
        yield* git(clone, ["push", "origin", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        const core = yield* GitCore;
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              const details = await runPromise(core.statusDetails(source));
              expect(details.branch).toBe(featureBranch);
              expect(details.aheadCount).toBe(0);
              expect(details.behindCount).toBe(1);
            },
            {
              timeout: 10_000,
              interval: 100,
            },
          ),
        );
      }),
    );

    it.effect("statusDetails remains successful when upstream refresh fails after checkout", () =>
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

        const featureBranch = "feature-refresh-failure";
        yield* git(source, ["branch", featureBranch]);
        yield* git(source, ["checkout", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            refreshFetchAttempts += 1;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.refreshFailure",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "simulated fetch timeout",
              }),
            );
          }
          return realGitCore.execute(input);
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        const status = yield* core.statusDetails(source);
        expect(refreshFetchAttempts).toBe(1);
        expect(status.branch).toBe(featureBranch);
        expect(status.upstreamRef).toBe(`origin/${featureBranch}`);
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
      }),
    );

    it.effect("defers upstream refresh until statusDetails is requested", () =>
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

        const featureBranch = "feature/scoped-fetch";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            refreshFetchAttempts += 1;
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
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
        expect(refreshFetchAttempts).toBe(0);
        const status = yield* core.statusDetails(source);
        expect(status.branch).toBe(featureBranch);
        expect(refreshFetchAttempts).toBe(1);
      }),
    );
  });
});
