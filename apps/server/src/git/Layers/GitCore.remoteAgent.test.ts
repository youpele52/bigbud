import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { GitCore } from "../Services/GitCore.ts";
import { makeGitCore } from "./GitCore.ts";
import { RemoteAgentGitExecutorService } from "../../remote-agent/remoteAgentGit.ts";
import {
  initRepoWithCommit,
  makeIsolatedGitCore,
  GitCoreDependenciesLayer,
  makeIsolatedGitCoreWithRemote,
  makeTmpDir,
  TestLayer,
} from "./GitCore.test.helpers.ts";

it.layer(TestLayer)("GitCore remote read-only composition", (it) => {
  describe("explicit remote executor", () => {
    it.effect("uses the optional agent executor when it is composed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const local = yield* GitCore;
        const operations: string[] = [];
        const remote = yield* makeGitCore().pipe(
          Effect.provide(
            Layer.mergeAll(
              GitCoreDependenciesLayer,
              Layer.succeed(RemoteAgentGitExecutorService, (input) => {
                operations.push(input.operation);
                return local.execute({ ...input, executionTargetId: "local" });
              }),
            ),
          ),
        );

        const status = yield* remote.status({ cwd, executionTargetId: "ssh:example" });

        expect(status.isRepo).toBe(true);
        expect(operations.length).toBeGreaterThan(0);
      }),
    );

    it.effect("reuses local status parsing with the remote executor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const local = yield* GitCore;
        const operations: string[] = [];
        const targets: Array<string | undefined> = [];
        const remote = yield* makeIsolatedGitCoreWithRemote({
          execute: local.execute,
          remoteExecute: (input) => {
            operations.push(input.operation);
            targets.push(input.executionTargetId);
            return local.execute({ ...input, executionTargetId: "local" });
          },
        });

        const status = yield* remote.status({ cwd, executionTargetId: "ssh:example" });

        expect(status.isRepo).toBe(true);
        expect(operations.length).toBeGreaterThan(0);
        expect(operations.every((operation) => operation.startsWith("GitCore."))).toBe(true);
        expect(targets.every((target) => target === "ssh:example")).toBe(true);
      }),
    );

    it.effect("routes remote history and commit details through the executor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const local = yield* GitCore;
        const remote = yield* makeIsolatedGitCoreWithRemote({
          execute: local.execute,
          remoteExecute: (input) => local.execute({ ...input, executionTargetId: "local" }),
        });

        const history = yield* remote.listCommits({
          cwd,
          executionTargetId: "ssh:example",
          limit: 20,
        });
        const firstCommit = history.commits[0];
        expect(firstCommit?.subject).toBe("initial commit");
        if (!firstCommit) {
          return;
        }

        const details = yield* remote.getCommitDetails({
          cwd,
          commit: firstCommit.sha,
          executionTargetId: "ssh:example",
        });

        expect(details.commit.sha).toBe(firstCommit.sha);
        expect(details.commit.files).toEqual([{ path: "README.md", insertions: 1, deletions: 0 }]);
      }),
    );

    it.effect("routes branch mutations through the remote executor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const local = yield* GitCore;
        const targets: Array<string | undefined> = [];
        const remote = yield* makeIsolatedGitCoreWithRemote({
          execute: local.execute,
          remoteExecute: (input) => {
            targets.push(input.executionTargetId);
            return local.execute({ ...input, executionTargetId: "local" });
          },
        });

        yield* remote.createBranch({
          cwd,
          branch: "remote-branch",
          executionTargetId: "ssh:example",
          checkout: true,
        });
        const renamed = yield* remote.renameBranch({
          cwd,
          oldBranch: "remote-branch",
          newBranch: "remote-renamed",
          executionTargetId: "ssh:example",
        });
        expect(renamed.branch).toBe("remote-renamed");
        yield* remote.checkoutBranch({
          cwd,
          branch: initialBranch,
          executionTargetId: "ssh:example",
        });
        yield* remote.deleteBranch({
          cwd,
          branch: "remote-renamed",
          executionTargetId: "ssh:example",
        });
        expect(targets.length).toBeGreaterThan(0);
        expect(targets.every((target) => target === "ssh:example")).toBe(true);
      }),
    );

    it.effect("never falls back to the local path for an unconfigured target", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const local = yield* GitCore;
        const remote = yield* makeIsolatedGitCore(local.execute);

        yield* expectEffectFailure(remote.statusDetails(cwd, "ssh:example"), "Git execution");
        yield* expectEffectFailure(remote.discardChanges(cwd, "ssh:example"), "Git execution");
      }),
    );
  });
});

function expectEffectFailure<A, E>(effect: Effect.Effect<A, E>, detail: string) {
  return Effect.promise(async () => {
    await expect(Effect.runPromise(effect)).rejects.toThrow(detail);
  });
}
