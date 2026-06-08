import path from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  configureRemote,
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
      "pushes renamed PR worktree branches to their tracked upstream branch even when push.default is current",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fork = yield* makeTmpDir();
          yield* git(fork, ["init", "--bare"]);

          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["remote", "add", "jasonLaster", fork]);
          yield* git(tmp, ["checkout", "-b", "statemachine"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "fork branch"]);
          yield* git(tmp, ["push", "-u", "jasonLaster", "statemachine"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* git(tmp, ["branch", "-D", "statemachine"]);
          yield* git(tmp, [
            "checkout",
            "-b",
            "t3code/pr-488/statemachine",
            "--track",
            "jasonLaster/statemachine",
          ]);
          yield* git(tmp, ["config", "push.default", "current"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "updated fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "update reviewed PR branch"]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);

          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(false);
          expect(pushed.upstreamBranch).toBe("jasonLaster/statemachine");
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            "jasonLaster/statemachine",
          );
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "statemachine"]),
          ).toContain("statemachine");
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "t3code/pr-488/statemachine"]),
          ).toBe("");
        }),
    );

    it.effect("pushes to the tracked upstream when the remote name contains slashes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        const prefixRemote = yield* makeTmpDir();
        const prefixFetchNamespace = "prefix-my-org";
        const prefixRemoteName = "my-org";
        const remoteName = "my-org/upstream";
        const featureBranch = "feature/slash-remote-push";
        yield* git(remote, ["init", "--bare"]);
        yield* git(prefixRemote, ["init", "--bare"]);

        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* configureRemote(tmp, prefixRemoteName, prefixRemote, prefixFetchNamespace);
        yield* configureRemote(tmp, remoteName, remote, remoteName);
        yield* git(tmp, ["push", "-u", remoteName, initialBranch]);

        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "first revision\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature base"]);
        yield* git(tmp, ["push", "-u", remoteName, featureBranch]);

        yield* writeTextFile(path.join(tmp, "feature.txt"), "second revision\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature update"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(false);
        expect(pushed.upstreamBranch).toBe(`${remoteName}/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `${remoteName}/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", remoteName, featureBranch])).toContain(
          featureBranch,
        );
      }),
    );

    it.effect("includes command context when worktree removal fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const missingWorktreePath = path.join(tmp, "missing-worktree");

        const removeResult = yield* Effect.result(
          core.removeWorktree({ cwd: tmp, path: missingWorktreePath }),
        );
        expect(removeResult._tag).toBe("Failure");
        if (removeResult._tag !== "Failure") {
          return;
        }
        const message = removeResult.failure.message;
        expect(message).toContain("git worktree remove");
        expect(message).toContain(`cwd: ${tmp}`);
        expect(message).toContain(missingWorktreePath);
      }),
    );

    it.effect(
      "refreshes upstream before statusDetails so behind count reflects remote updates",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const clone = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);

          yield* git(clone, ["clone", remote, "."]);
          yield* git(clone, ["config", "user.email", "test@test.com"]);
          yield* git(clone, ["config", "user.name", "Test"]);
          yield* git(clone, [
            "checkout",
            "-B",
            initialBranch,
            "--track",
            `origin/${initialBranch}`,
          ]);
          yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
          yield* git(clone, ["add", "CHANGELOG.md"]);
          yield* git(clone, ["commit", "-m", "remote update"]);
          yield* git(clone, ["push", "origin", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe(initialBranch);
          expect(details.aheadCount).toBe(0);
          expect(details.behindCount).toBe(1);
        }),
    );

    it.effect("pushes with upstream setup and then skips when up to date", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/core-push" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/core-push" });

        yield* writeTextFile(path.join(tmp, "feature.txt"), "push me\n");
        const core = yield* GitCore;
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        yield* core.commit(tmp, "Add feature file", "");

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/core-push",
        );

        const skipped = yield* core.pushCurrentBranch(tmp, null);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("pulls behind branch and then reports up-to-date", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
        yield* git(clone, ["add", "CHANGELOG.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        const core = yield* GitCore;
        const pulled = yield* core.pullCurrentBranch(source);
        expect(pulled.status).toBe("pulled");
        expect((yield* core.statusDetails(source)).behindCount).toBe(0);

        const skipped = yield* core.pullCurrentBranch(source);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("top-level pullGitBranch rejects when no upstream exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result((yield* GitCore).pullCurrentBranch(tmp));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message.toLowerCase()).toContain("no upstream");
        }
      }),
    );
  });
});
