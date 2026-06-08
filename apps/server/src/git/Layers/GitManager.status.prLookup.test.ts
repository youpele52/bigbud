import fs from "node:fs";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { GitManagerTestLayer, makeManager } from "./GitManager.test.helpers.ts";
import {
  configureRemote,
  createBareRemote,
  initRepo,
  makeTempDir,
  runGit,
} from "./GitManager.test.repo.ts";

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect(
    "status ignores unrelated fork PRs when the current branch tracks the same repository",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([
                {
                  number: 1661,
                  title: "Fork PR from main",
                  url: "https://github.com/youpele52/bigbud/pull/1661",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-04-01T15:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "lnieuwenhuis/t3code",
                  },
                  headRepositoryOwner: {
                    login: "lnieuwenhuis",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("main");
        expect(status.pr).toBeNull();
      }),
  );

  it.effect(
    "status detects cross-repo PRs from the upstream remote URL owner",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        fs.writeFileSync(path.join(repoDir, "fork-pr.txt"), "fork pr\n");
        yield* runGit(repoDir, ["add", "fork-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-488/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* runGit(repoDir, [
          "config",
          "remote.fork-seed.url",
          "git@github.com:jasonLaster/codething-mvp.git",
        ]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([]),
              JSON.stringify([]),
              JSON.stringify([
                {
                  number: 488,
                  title: "Rebase this PR on latest main",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/488",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "jasonLaster/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "jasonLaster",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("t3code/pr-488/statemachine");
        expect(status.pr).toEqual({
          number: 488,
          title: "Rebase this PR on latest main",
          url: "https://github.com/pingdotgg/codething-mvp/pull/488",
          baseBranch: "main",
          headBranch: "statemachine",
          state: "open",
        });
        expect(ghCalls).toContain(
          "pr list --head jasonLaster:statemachine --state all --limit 20 --json number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        );
      }),
    60_000,
  );

  it.effect(
    "status ignores synthetic local branch aliases when the upstream remote name contains slashes",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* runGit(repoDir, [
          "config",
          "remote.origin.url",
          "git@github.com:pingdotgg/codething-mvp.git",
        ]);
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        yield* runGit(repoDir, [
          "config",
          "remote.my-org/upstream.url",
          "git@github.com:pingdotgg/codething-mvp.git",
        ]);
        yield* runGit(repoDir, ["config", "remote.my-org/upstream.pushurl", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);

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
                  state: "OPEN",
                  updatedAt: "2026-03-01T10:00:00Z",
                },
              ]),
              "upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/youpele52/bigbud/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
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
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
              "my-org/upstream:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/youpele52/bigbud/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("upstream/effect-atom");
        expect(status.pr).toEqual({
          number: 1618,
          title: "Correct PR",
          url: "https://github.com/youpele52/bigbud/pull/1618",
          baseBranch: "main",
          headBranch: "effect-atom",
          state: "open",
        });
        expect(ghCalls.some((call) => call.includes("pr list --head upstream/effect-atom "))).toBe(
          false,
        );
        expect(
          ghCalls.some((call) => call.includes("pr list --head pingdotgg:upstream/effect-atom ")),
        ).toBe(false);
        expect(
          ghCalls.some((call) =>
            call.includes("pr list --head my-org/upstream:upstream/effect-atom "),
          ),
        ).toBe(false);
      }),
    60_000,
  );

  it.effect("status returns merged PR state when latest PR was merged", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-merged-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 22,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/22",
                baseRefName: "main",
                headRefName: "feature/status-merged-pr",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-merged-pr");
      expect(status.pr).toEqual({
        number: 22,
        title: "Merged PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/22",
        baseBranch: "main",
        headBranch: "feature/status-merged-pr",
        state: "merged",
      });
    }),
  );

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 45,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/45",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "MERGED",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              },
              {
                number: 46,
                title: "Open PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/46",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "OPEN",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual({
        number: 46,
        title: "Open PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/46",
        baseBranch: "main",
        headBranch: "feature/status-open-over-merged",
        state: "open",
      });
    }),
  );

  it.effect("status hides merged PRs on the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 23,
                title: "Merged PR",
                url: "https://github.com/youpele52/bigbud/pull/23",
                baseRefName: "feature/status-default-branch-target",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("main");
      expect(status.pr).toBeNull();
    }),
  );
});
