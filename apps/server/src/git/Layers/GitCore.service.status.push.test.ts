import path from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  git,
  initRepoWithCommit,
  makeTmpDir,
  TestLayer,
  writeTextFile,
} from "./GitCore.test.helpers.ts";
import { GitCore } from "../Services/GitCore.ts";

it.layer(TestLayer)("git integration", (it) => {
  describe("GitCore", () => {
    it.effect(
      "computes ahead count against origin/default when local default branch is missing",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/remote-base-only"]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of origin/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/remote-base-only");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect(
      "computes ahead count against a non-origin remote-prefixed gh-merge-base candidate",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const remoteName = "fork-seed";
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", remoteName, remote]);
          yield* git(source, ["push", "-u", remoteName, initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/non-origin-merge-base"]);
          yield* git(source, [
            "config",
            "branch.feature/non-origin-merge-base.gh-merge-base",
            `${remoteName}/${initialBranch}`,
          ]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of ${remoteName}/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/non-origin-merge-base");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect("skips push when no upstream is configured and branch is not ahead of base", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("skipped_up_to_date");
        expect(pushed.branch).toBe("feature/no-upstream-no-ahead");
        expect(pushed.setUpstream).toBeUndefined();
      }),
    );

    it.effect("pushes with upstream setup when no comparable base branch exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=trunk"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/no-base"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("origin/feature/no-base");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/no-base",
        );
      }),
    );

    it.effect("pushes with upstream setup to the only configured non-origin remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=main"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "fork", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/fork-only"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("fork/feature/fork-only");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "fork/feature/fork-only",
        );
      }),
    );

    it.effect(
      "pushes with upstream setup when comparable base exists but remote branch is missing",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(tmp);
          const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "-u", "origin", initialBranch]);

          yield* writeTextFile(path.join(tmp, "default-ahead.txt"), "ahead on default\n");
          yield* git(tmp, ["add", "default-ahead.txt"]);
          yield* git(tmp, ["commit", "-m", "default ahead"]);

          const featureBranch = "feature/publish-no-upstream";
          yield* git(tmp, ["checkout", "-b", featureBranch]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);
          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(true);
          expect(pushed.upstreamBranch).toBe(`origin/${featureBranch}`);
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `origin/${featureBranch}`,
          );
          expect(yield* git(tmp, ["ls-remote", "--heads", "origin", featureBranch])).toContain(
            featureBranch,
          );
        }),
    );

    it.effect("prefers branch pushRemote over origin when setting upstream", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const origin = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        yield* git(origin, ["init", "--bare"]);
        yield* git(fork, ["init", "--bare"]);

        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(tmp, ["remote", "add", "origin", origin]);
        yield* git(tmp, ["remote", "add", "fork", fork]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);

        const featureBranch = "feature/push-remote";
        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* git(tmp, ["config", `branch.${featureBranch}.pushRemote`, "fork"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "push to fork\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe(`fork/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `fork/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", "fork", featureBranch])).toContain(
          featureBranch,
        );
      }),
    );
  });
});
