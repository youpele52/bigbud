import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer } from "effect";
import { describe, expect } from "vitest";

import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ServerConfig } from "../../startup/config.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "bigbud-checkpoint-identity-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  GitCoreTestLayer,
  CheckpointStoreLive.pipe(Layer.provide(GitCoreTestLayer), Layer.provide(NodeServices.layer)),
);

const makeTmpDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-identity-" });
});

const initRepo = Effect.fn("CheckpointStore.identity.test.initRepo")(function* (cwd: string) {
  const git = yield* GitCore;
  yield* git.initRepo({ cwd });
  yield* git.execute({
    operation: "CheckpointStore.identity.test.configEmail",
    cwd,
    args: ["config", "user.email", "test@test.com"],
  });
  yield* git.execute({
    operation: "CheckpointStore.identity.test.configName",
    cwd,
    args: ["config", "user.name", "Test"],
  });
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path.join(cwd, "README.md"), "test\n");
  yield* git.execute({ operation: "CheckpointStore.identity.test.add", cwd, args: ["add", "."] });
  yield* git.execute({
    operation: "CheckpointStore.identity.test.commit",
    cwd,
    args: ["commit", "-m", "initial"],
  });
});

it.layer(TestLayer)("CheckpointStore repository identity", (it) => {
  it.effect("does not treat a nested directory in a parent worktree as a repository root", () =>
    Effect.gen(function* () {
      const store = yield* CheckpointStore;
      expect(yield* store.isGitRepository(path.join(process.cwd(), "src"))).toBe(false);
    }),
  );

  describe("path safety", () => {
    it.effect("rejects a symlink workspace and a symlink ancestor", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir;
        const fs = yield* FileSystem.FileSystem;
        const repo = path.join(root, "repo");
        yield* fs.makeDirectory(repo);
        yield* initRepo(repo);
        const workspaceLink = path.join(root, "workspace-link");
        yield* fs.symlink(repo, workspaceLink);
        const ancestorLink = path.join(root, "ancestor-link");
        yield* fs.symlink(root, ancestorLink);
        const store = yield* CheckpointStore;

        expect(
          Exit.isFailure(yield* Effect.exit(store.captureRepositoryIdentity(workspaceLink))),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(store.captureRepositoryIdentity(path.join(ancestorLink, "repo"))),
          ),
        ).toBe(true);
      }),
    );

    it.effect("rejects a symlink Git common directory", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir;
        const fs = yield* FileSystem.FileSystem;
        const repo = path.join(root, "repo");
        const commonDir = path.join(root, "common.git");
        const git = yield* GitCore;
        yield* fs.makeDirectory(repo);
        yield* git.execute({
          operation: "CheckpointStore.identity.test.initSeparate",
          cwd: root,
          args: ["init", `--separate-git-dir=${commonDir}`, repo],
        });
        const backingDir = path.join(root, "common.backing.git");
        yield* fs.rename(commonDir, backingDir);
        yield* fs.symlink(backingDir, commonDir);
        const store = yield* CheckpointStore;

        expect(Exit.isFailure(yield* Effect.exit(store.captureRepositoryIdentity(repo)))).toBe(
          true,
        );
      }),
    );
  });

  it.effect("rejects workspace substitution before delete and verify", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const fs = yield* FileSystem.FileSystem;
      const repo = path.join(root, "repo");
      yield* fs.makeDirectory(repo);
      yield* initRepo(repo);
      const store = yield* CheckpointStore;
      const identity = yield* store.captureRepositoryIdentity(repo);
      yield* fs.rename(repo, path.join(root, "original-repo"));
      yield* fs.makeDirectory(repo);
      yield* initRepo(repo);
      const ref = checkpointRefForThreadTurn(ThreadId.makeUnsafe("replacement"), 1);
      const git = yield* GitCore;
      yield* git.execute({
        operation: "CheckpointStore.identity.test.addReplacementRef",
        cwd: repo,
        args: ["update-ref", ref, "HEAD"],
      });

      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.deleteCheckpointRefs({ cwd: repo, checkpointRefs: [ref], identity }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.verifyCheckpointRefsAbsent({ cwd: repo, checkpointRefs: [], identity }),
          ),
        ),
      ).toBe(true);
      expect(
        (yield* git.execute({
          operation: "CheckpointStore.identity.test.verifyReplacementRef",
          cwd: repo,
          args: ["show-ref", "--verify", "--quiet", ref],
          allowNonZeroExit: true,
        })).code,
      ).toBe(0);
    }),
  );

  it.effect("rejects Git common-directory substitution before listing", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const fs = yield* FileSystem.FileSystem;
      const repo = path.join(root, "repo");
      yield* fs.makeDirectory(repo);
      yield* initRepo(repo);
      const store = yield* CheckpointStore;
      const identity = yield* store.captureRepositoryIdentity(repo);
      yield* fs.rename(path.join(repo, ".git"), path.join(repo, ".git-original"));
      const git = yield* GitCore;
      yield* git.initRepo({ cwd: repo });

      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.listThreadCheckpointRefs({
              cwd: repo,
              threadId: ThreadId.makeUnsafe("common-dir-substitution"),
              identity,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );
});
