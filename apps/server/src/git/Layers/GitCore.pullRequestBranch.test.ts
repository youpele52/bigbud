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
  describe("fetchPullRequestBranch", () => {
    it.effect("fetches a GitHub pull request ref into a local branch without checkout", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const remoteDir = yield* makeTmpDir("git-remote-");
        yield* git(remoteDir, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remoteDir]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);
        yield* git(tmp, ["checkout", "-b", "feature/pr-fetch"]);
        yield* writeTextFile(path.join(tmp, "pr-fetch.txt"), "fetch me\n");
        yield* git(tmp, ["add", "pr-fetch.txt"]);
        yield* git(tmp, ["commit", "-m", "Add PR fetch branch"]);
        yield* git(tmp, ["push", "-u", "origin", "feature/pr-fetch"]);
        yield* git(tmp, ["push", "origin", "HEAD:refs/pull/55/head"]);
        yield* git(tmp, ["checkout", initialBranch]);

        yield* (yield* GitCore).fetchPullRequestBranch({
          cwd: tmp,
          prNumber: 55,
          branch: "feature/pr-fetch",
        });

        const localBranches = yield* git(tmp, ["branch", "--list", "feature/pr-fetch"]);
        expect(localBranches).toContain("feature/pr-fetch");
        const currentBranch = yield* git(tmp, ["branch", "--show-current"]);
        expect(currentBranch).toBe(initialBranch);
      }),
    );
  });

  describe("full flow: thread switching (checkout toggling)", () => {
    it.effect("checkout a → checkout b → checkout a → current matches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-b" });

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        let branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-b" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
      }),
    );
  });

  describe("full flow: checkout conflict", () => {
    it.effect("uncommitted changes prevent checkout to a diverged branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "diverged" });

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" });
        yield* writeTextFile(path.join(tmp, "README.md"), "diverged content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "diverge"]);

        const allBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });

        yield* writeTextFile(path.join(tmp, "README.md"), "local uncommitted\n");

        const failedCheckout = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" }),
        );
        expect(failedCheckout._tag).toBe("Failure");

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
      }),
    );
  });
});
