import fs from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";

import { GitManagerTestLayer, makeManager, runStackedAction } from "./GitManager.test.helpers.ts";
import {
  configureGitHubRemoteMirror,
  configureRemote,
  createBareRemote,
  initRepo,
  makeTempDir,
  runGit,
} from "./GitManager.test.repo.ts";

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("returns existing PR metadata for commit/push/pr action", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/existing-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/existing-pr"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 42,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                baseRefName: "main",
                headRefName: "feature/existing-pr",
              },
            ]),
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(42);
      expect(result.toast).toEqual({
        title: "Opened PR #42",
        description: "Existing PR",
        cta: {
          kind: "open_pr",
          label: "View PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        },
      });
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect(
    "returns existing cross-repo PR metadata using the fork owner selector",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("bigbud-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* configureGitHubRemoteMirror(
          repoDir,
          "fork-seed",
          forkDir,
          "git@github.com:octocat/codething-mvp.git",
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([]),
              JSON.stringify([
                {
                  number: 142,
                  title: "Existing fork PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/142",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
            ],
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);
        expect(
          ghCalls.some((call) =>
            call.includes("pr list --head octocat:statemachine --state open --limit 1"),
          ),
        ).toBe(true);
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
      }),
    60_000,
  );

  it.effect(
    "returns the correct existing PR when a slash remote checks out to a synthetic local alias",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("bigbud-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* configureGitHubRemoteMirror(
          repoDir,
          "origin",
          originDir,
          "git@github.com:pingdotgg/codething-mvp.git",
        );
        yield* configureGitHubRemoteMirror(
          repoDir,
          "my-org/upstream",
          upstreamDir,
          "git@github.com:pingdotgg/codething-mvp.git",
        );
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
        yield* runGit(repoDir, ["add", "changes.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              "effect-atom": JSON.stringify([
                {
                  number: 1618,
                  title: "Correct PR",
                  url: "https://github.com/youpele52/bigbud/pull/1618",
                  baseRefName: "main",
                  headRefName: "effect-atom",
                },
              ]),
              "upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/youpele52/bigbud/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                },
              ]),
              "pingdotgg:effect-atom": JSON.stringify([]),
              "my-org/upstream:effect-atom": JSON.stringify([]),
              "pingdotgg:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/youpele52/bigbud/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                },
              ]),
              "my-org/upstream:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/youpele52/bigbud/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                },
              ]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(1618);
        expect(ghCalls.some((call) => call.includes("pr list --head upstream/effect-atom "))).toBe(
          false,
        );
      }),
    60_000,
  );

  it.effect(
    "prefers owner-qualified selectors before bare branch names for cross-repo PRs",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("bigbud-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "bigbud/pr-142/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* configureGitHubRemoteMirror(
          repoDir,
          "fork-seed",
          forkDir,
          "git@github.com:octocat/codething-mvp.git",
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              "bigbud/pr-142/statemachine": JSON.stringify([]),
              statemachine: JSON.stringify([
                {
                  number: 41,
                  title: "Unrelated same-repo PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/41",
                  baseRefName: "main",
                  headRefName: "statemachine",
                },
              ]),
              "octocat:statemachine": JSON.stringify([
                {
                  number: 142,
                  title: "Existing fork PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/142",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
              "fork-seed:statemachine": JSON.stringify([]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);

        const ownerSelectorCallIndex = ghCalls.findIndex((call) =>
          call.includes("pr list --head octocat:statemachine --state open --limit 1"),
        );
        expect(ownerSelectorCallIndex).toBeGreaterThanOrEqual(0);
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
      }),
    60_000,
  );

  it.effect(
    "stops probing head selectors after finding an existing PR",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("bigbud-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "bigbud/pr-142/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* configureGitHubRemoteMirror(
          repoDir,
          "fork-seed",
          forkDir,
          "git@github.com:octocat/codething-mvp.git",
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              "octocat:statemachine": JSON.stringify([
                {
                  number: 142,
                  title: "Existing fork PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/142",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
              "fork-seed:statemachine": JSON.stringify([]),
              "bigbud/pr-142/statemachine": JSON.stringify([]),
              statemachine: JSON.stringify([]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);

        const openLookupCalls = ghCalls.filter((call) => call.includes("--state open --limit 1"));
        expect(openLookupCalls).toHaveLength(1);
        expect(openLookupCalls[0]).toContain(
          "pr list --head octocat:statemachine --state open --limit 1",
        );
      }),
    20_000,
  );
});
