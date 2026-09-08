import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";

import type { GitCoreShape } from "../Services/GitCore.ts";
import {
  GitManagerTestLayer,
  makeManager,
  preparePullRequestThread,
} from "./GitManager.test.helpers.ts";

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("reuses stable distinct Git identities when PR thread preparation is retried", () =>
    Effect.gen(function* () {
      const operationIds: string[] = [];
      const record = (operationId: string | undefined) =>
        Effect.sync(() => {
          operationIds.push(operationId ?? "missing");
        });
      const gitCore = {
        statusDetails: () => Effect.succeed({ branch: "main" }),
        listBranches: () =>
          Effect.succeed({
            branches: [],
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: 0,
          }),
        readConfigValue: () => Effect.succeed("https://github.com/example/repo.git"),
        ensureRemote: (input: { readonly operationId?: string }) =>
          record(input.operationId).pipe(Effect.as("fork")),
        fetchRemoteBranch: (input: { readonly operationId?: string }) => record(input.operationId),
        setBranchUpstream: (input: { readonly operationId?: string }) => record(input.operationId),
        createWorktree: (input: { readonly branch: string; readonly operationId?: string }) =>
          record(input.operationId).pipe(
            Effect.as({ worktree: { path: `${process.cwd()}/pr-worktree`, branch: input.branch } }),
          ),
      } as unknown as GitCoreShape;
      const { manager } = yield* makeManager({
        gitCore,
        ghScenario: {
          pullRequest: {
            number: 42,
            title: "Stable preparation",
            url: "https://github.com/example/repo/pull/42",
            baseRefName: "main",
            headRefName: "feature/stable-preparation",
            state: "open",
            headRepositoryNameWithOwner: "example/repo",
            headRepositoryOwnerLogin: "example",
          },
          repositoryCloneUrls: {
            "example/repo": {
              url: "https://github.com/example/repo.git",
              sshUrl: "git@github.com:example/repo.git",
            },
          },
        },
      });
      const input = {
        cwd: process.cwd(),
        reference: "#42",
        mode: "worktree" as const,
        operationId: "prepare-retry-1",
      };

      yield* preparePullRequestThread(manager, input);
      const firstAttempt = [...operationIds];
      operationIds.length = 0;
      yield* preparePullRequestThread(manager, input);

      expect(firstAttempt).toEqual(operationIds);
      expect(firstAttempt.every((operationId) => operationId !== "missing")).toBe(true);
      expect(new Set(firstAttempt).size).toBeGreaterThan(1);
    }),
  );
});
