import fs from "node:fs";
import path from "node:path";

import type { GitActionProgressEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";

import { GitManagerTestLayer, makeManager, runStackedAction } from "./GitManager.test.helpers.ts";
import { createBareRemote, initRepo, makeTempDir, runGit } from "./GitManager.test.repo.ts";

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("emits ordered progress events for commit hooks", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hooked.txt"), "hooked\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: start" >&2\nsleep 1\necho "hook: end" >&2\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-1",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("created");
      expect(events.map((event) => event.kind)).toContain("action_started");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "phase_started",
            phase: "commit",
          }),
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: start",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: end",
          }),
          expect.objectContaining({
            kind: "hook_finished",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_finished",
          }),
        ]),
      );
    }),
  );

  it.effect("emits action_failed when a commit hook rejects", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hook-failure.txt"), "broken\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: fail" >&2\nexit 1\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const errorMessage = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-2",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      ).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("hook: fail");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_failed",
            phase: "commit",
          }),
        ]),
      );
    }),
  );

  it.effect("create_pr emits only the PR phase when the branch is already pushed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("bigbud-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-only-follow-up"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "pr-only.txt"), "pr only\n");
      yield* runGit(repoDir, ["add", "pr-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR only branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-only-follow-up"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([]),
            JSON.stringify([
              {
                number: 201,
                title: "PR only branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/201",
                baseRefName: "main",
                headRefName: "feature/pr-only-follow-up",
                state: "OPEN",
                isCrossRepository: false,
              },
            ]),
          ],
        },
      });
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "create_pr",
        },
        {
          actionId: "action-pr-only",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("created");
      expect(
        events.filter(
          (event): event is Extract<GitActionProgressEvent, { kind: "phase_started" }> =>
            event.kind === "phase_started",
        ),
      ).toEqual([
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Preparing PR...",
        }),
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Generating PR content...",
        }),
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Creating GitHub pull request...",
        }),
      ]);
    }),
  );
});
