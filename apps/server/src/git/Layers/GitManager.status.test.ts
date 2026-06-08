import path from "node:path";

import { GitHubCliError } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { GitManagerTestLayer, makeManager } from "./GitManager.test.helpers.ts";
import { createBareRemote, initRepo, makeTempDir, runGit } from "./GitManager.test.repo.ts";

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("status includes PR metadata when branch already has an open PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 13,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/13",
                baseRefName: "main",
                headRefName: "feature/status-open-pr",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.isRepo).toBe(true);
      expect(status.hasOriginRemote).toBe(true);
      expect(status.isDefaultBranch).toBe(false);
      expect(status.branch).toBe("feature/status-open-pr");
      expect(status.pr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/13",
        baseBranch: "main",
        headBranch: "feature/status-open-pr",
        state: "open",
      });
    }),
  );

  it.effect("status returns an explicit non-repo result for non-git directories", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("bigbud-git-manager-non-repo-");
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasOriginRemote: false,
        isDefaultBranch: false,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status returns an explicit non-repo result for missing directories", () =>
    Effect.gen(function* () {
      const parentDir = yield* makeTempDir("bigbud-git-manager-missing-dir-");
      const { manager } = yield* makeManager();

      const cwd = path.join(parentDir, "missing");

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasOriginRemote: false,
        isDefaultBranch: false,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status briefly caches repeated lookups for the same cwd", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-cache"]);

      const existingPr = {
        number: 113,
        title: "Cached PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/113",
        baseRefName: "main",
        headRefName: "feature/status-cache",
      };
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [JSON.stringify([existingPr]), JSON.stringify([existingPr])],
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      const second = yield* manager.status({ cwd: repoDir });

      expect(first.pr?.number).toBe(113);
      expect(second.pr?.number).toBe(113);
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns pr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );
});
