import fs from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as RemoteDefault from "../../remote-agent/remoteAgentDefault.ts";

import type { GitCoreShape } from "../Services/GitCore.ts";
import { GitManagerTestLayer, makeManager, runStackedAction } from "./GitManager.test.helpers.ts";
import { createBareRemote, initRepo, makeTempDir, runGit } from "./GitManager.test.repo.ts";

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nworld\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Push",
          action: {
            kind: "push",
          },
        },
      });
      expect(result.toast.title).toMatch(/^Committed [0-9a-f]{7}$/);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );

  it.effect("uses custom commit message when provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "this should not be used",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feat: custom summary line");
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%b"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toContain("- details from user");
    }),
  );

  it.effect("commits only selected files when filePaths is provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "a.txt"), "file a\n");
      fs.writeFileSync(path.join(repoDir, "b.txt"), "file b\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        filePaths: ["a.txt"],
      });

      expect(result.commit.status).toBe("created");

      const statusStdout = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(statusStdout).toContain("b.txt");
      expect(statusStdout).not.toContain("a.txt");
    }),
  );

  it.effect("keeps the Create PR CTA for an explicit local execution target", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        executionTargetId: "local",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      });
      expect(result.toast.title).toMatch(
        /^Pushed [0-9a-f]{7} to origin\/feature\/implement-stacked-git-actions$/,
      );
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feature/implement-stacked-git-actions");

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );

  it.effect("featureBranch uses custom commit message and derives branch name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom-feature\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "unused",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/feat-custom-summary-line");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", result.branch.name!]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
    }),
  );

  it.effect("skips commit when there are no uncommitted changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
    }),
  );

  it.effect("featureBranch returns error when worktree is clean", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("no changes to commit");
    }),
  );

  it.effect("commits and pushes with upstream auto-setup when needed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/stacked-flow"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.push.setUpstream).toBe(true);
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("origin/feature/stacked-flow");
    }),
  );

  it.effect("uses distinct stable mutation identities for separate stacked actions", () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(RemoteDefault, "getConfiguredRemoteAgentComposition").mockReturnValue(null),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const operationIds = {
        prepare: [] as Array<string | undefined>,
        commit: [] as Array<string | undefined>,
        push: [] as Array<string | undefined>,
        branch: [] as Array<string | undefined>,
        checkout: [] as Array<string | undefined>,
      };
      const gitCore = {
        statusDetails: () =>
          Effect.succeed({
            isRepo: true,
            hasOriginRemote: true,
            isDefaultBranch: true,
            branch: "main",
            hasWorkingTreeChanges: true,
            workingTree: [],
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            upstreamRef: "origin/main",
          }),
        prepareCommitContext: (
          _cwd: string,
          _filePaths: readonly string[] | undefined,
          _executionTargetId: string | undefined,
          operationId: string | undefined,
        ) => {
          operationIds.prepare.push(operationId);
          return Effect.succeed({ stagedSummary: "M README.md", stagedPatch: "diff" });
        },
        commit: (
          _cwd: string,
          _subject: string,
          _body: string,
          options: { operationId?: string },
        ) => {
          operationIds.commit.push(options.operationId);
          return Effect.succeed({ commitSha: "commit-sha" });
        },
        pushCurrentBranch: (
          _cwd: string,
          _fallbackBranch: string | null,
          _executionTargetId: string | undefined,
          operationId: string | undefined,
        ) => {
          operationIds.push.push(operationId);
          return Effect.succeed({
            status: "pushed" as const,
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
        },
        listLocalBranchNames: () => Effect.succeed([]),
        createBranch: (input: { operationId?: string }) => {
          operationIds.branch.push(input.operationId);
          return Effect.succeed({ branch: "feature/implement-stacked-git-actions" });
        },
        checkoutBranch: (input: { operationId?: string }) => {
          operationIds.checkout.push(input.operationId);
          return Effect.succeed({ branch: "feature/implement-stacked-git-actions" });
        },
      } as unknown as GitCoreShape;
      const { manager } = yield* makeManager({ gitCore });

      yield* runStackedAction(manager, {
        cwd: "/remote/project",
        action: "commit_push",
        actionId: "git-action-1",
        executionTargetId: "ssh:example",
        featureBranch: true,
      });
      yield* runStackedAction(manager, {
        cwd: "/remote/project",
        action: "commit_push",
        actionId: "git-action-2",
        executionTargetId: "ssh:example",
        featureBranch: true,
      });

      expect(operationIds.prepare).toEqual(["git-action-1:commit", "git-action-2:commit"]);
      expect(operationIds.commit).toEqual(["git-action-1:commit", "git-action-2:commit"]);
      expect(operationIds.push).toEqual(["git-action-1:push", "git-action-2:push"]);
      expect(operationIds.branch).toEqual([
        "git-action-1:branch.create",
        "git-action-2:branch.create",
      ]);
      expect(operationIds.checkout).toEqual([
        "git-action-1:branch.checkout",
        "git-action-2:branch.checkout",
      ]);
      expect(new Set(operationIds.commit).size).toBe(2);
      expect(new Set(operationIds.push).size).toBe(2);
    }),
  );
});
