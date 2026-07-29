import { it } from "@effect/vitest";
import type { GitBranch } from "@bigbud/contracts/workspace/git.domain.ts";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { GitCore } from "../Services/GitCore.ts";
import { git, initRepoWithCommit, makeTmpDir, TestLayer } from "./GitCore.test.helpers.ts";

function findBranch(branches: ReadonlyArray<GitBranch>, name: string, isRemote = false) {
  return branches.find((branch) => branch.name === name && Boolean(branch.isRemote) === isRemote);
}

it.layer(TestLayer)("git integration", (it) => {
  describe("listGitBranches web links", () => {
    it.effect("prefers supported origin then the first supported fetch remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", "first", "https://gitlab.com/acme/platform/project.git"]);
        yield* git(tmp, ["remote", "add", "origin", "git@github.com:acme/project.git"]);

        const core = yield* GitCore;
        const withOrigin = yield* core.listBranches({ cwd: tmp });
        expect(findBranch(withOrigin.branches, initialBranch)?.webLink).toEqual({
          provider: "github",
          repositoryUrl: "https://github.com/acme/project",
          branchUrl: `https://github.com/acme/project/tree/${initialBranch}`,
        });

        yield* git(tmp, ["remote", "set-url", "origin", "/tmp/local-repository.git"]);
        const withFirstSupported = yield* core.listBranches({ cwd: tmp });
        expect(findBranch(withFirstSupported.branches, initialBranch)?.webLink).toEqual({
          provider: "gitlab",
          repositoryUrl: "https://gitlab.com/acme/platform/project",
          branchUrl: `https://gitlab.com/acme/platform/project/-/tree/${initialBranch}`,
        });
      }),
    );

    it.effect("uses the configured local upstream remote and hosted branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const remoteName = "team/upstream";
        const hostedBranch = "release/next";
        yield* git(tmp, [
          "remote",
          "add",
          remoteName,
          "ssh://git@gitlab.com/acme/nested/project.git",
        ]);
        yield* git(tmp, ["update-ref", `refs/remotes/${remoteName}/${hostedBranch}`, "HEAD"]);
        yield* git(tmp, [
          "branch",
          `--set-upstream-to=${remoteName}/${hostedBranch}`,
          initialBranch,
        ]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(findBranch(result.branches, initialBranch)?.webLink).toEqual({
          provider: "gitlab",
          repositoryUrl: "https://gitlab.com/acme/nested/project",
          branchUrl: "https://gitlab.com/acme/nested/project/-/tree/release%2Fnext",
        });
      }),
    );

    it.effect("does not replace an unsupported explicit upstream with origin", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const localRemote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(localRemote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", "https://github.com/acme/project.git"]);
        yield* git(tmp, ["remote", "add", "local-upstream", localRemote]);
        yield* git(tmp, ["update-ref", "refs/remotes/local-upstream/hosted/main", "HEAD"]);
        yield* git(tmp, ["branch", "--set-upstream-to=local-upstream/hosted/main", initialBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(findBranch(result.branches, initialBranch)?.webLink).toBeUndefined();
      }),
    );

    it.effect("uses the exact remote and hosted name for remote branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const remoteName = "my-org/upstream";
        const hostedBranch = "feature/remote-only";
        yield* git(tmp, ["remote", "add", remoteName, "git@gitlab.com:acme/group/project.git"]);
        yield* git(tmp, ["update-ref", `refs/remotes/${remoteName}/${hostedBranch}`, "HEAD"]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(findBranch(result.branches, `${remoteName}/${hostedBranch}`, true)?.webLink).toEqual(
          {
            provider: "gitlab",
            repositoryUrl: "https://gitlab.com/acme/group/project",
            branchUrl: "https://gitlab.com/acme/group/project/-/tree/feature%2Fremote-only",
          },
        );
      }),
    );
  });
});
