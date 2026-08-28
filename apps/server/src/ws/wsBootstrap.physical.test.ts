import path from "node:path";
import { realpath } from "node:fs/promises";

import { it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, vi } from "vitest";

import {
  git as runGit,
  initRepoWithCommit,
  makeTmpDir,
  TestLayer,
} from "../git/Layers/GitCore.test.helpers.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import {
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { makeWsRpcTransportLockBindings } from "../server.routes.ts";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";
import { makeBootstrapCommandLock, type BootstrapCommandLock } from "./wsBootstrap.lock.ts";

const projectId = ProjectId.makeUnsafe("project-bootstrap-physical");
const threadId = ThreadId.makeUnsafe("thread-bootstrap-physical");
const parentCommandId = CommandId.makeUnsafe("cmd-bootstrap-physical");
const branch = "bigbud/bootstrap-physical";

const childCommandId = (tag: string) => CommandId.makeUnsafe(`server:${parentCommandId}:${tag}`);

const bootstrapCommand = (projectCwd: string, baseBranch: string) => ({
  type: "thread.turn.start" as const,
  commandId: parentCommandId,
  threadId,
  message: {
    messageId: MessageId.makeUnsafe("msg-bootstrap-physical"),
    role: "user" as const,
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required" as const,
  createdAt: "2026-08-27T00:00:00.000Z",
  bootstrap: {
    createThread: {
      projectId,
      title: "Physical recovery",
      modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
      runtimeMode: "approval-required" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: "2026-08-27T00:00:00.000Z",
    },
    prepareWorktree: { projectCwd, baseBranch, branch },
  },
});

const existingBranchBootstrapCommand = (projectCwd: string, baseBranch: string) => {
  const command = bootstrapCommand(projectCwd, baseBranch);
  return {
    ...command,
    bootstrap: {
      ...command.bootstrap,
      prepareWorktree: { projectCwd, baseBranch },
    },
  };
};

const projectCommand = (projectCwd: string): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.makeUnsafe("cmd-project-bootstrap-physical"),
  projectId,
  title: "Physical recovery",
  workspaceRoot: projectCwd,
  defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
  createdAt: "2026-08-27T00:00:00.000Z",
});

it.layer(TestLayer)("bootstrap physical retry recovery", (it) => {
  const withPhysicalFixture = (
    run: (fixture: {
      readonly dbPath: string;
      readonly projectCwd: string;
      readonly baseBranch: string;
      readonly existingBranch: string;
      readonly worktreePath: string;
      readonly createWorktree: ReturnType<typeof vi.fn>;
      readonly physicalGit: Parameters<typeof makeDispatchBootstrapThreadCommand>[1];
    }) => Promise<void>,
  ) =>
    Effect.gen(function* () {
      const projectCwd = yield* makeTmpDir("bootstrap-physical-repo-");
      const worktreeRoot = yield* makeTmpDir("bootstrap-physical-worktree-");
      const { initialBranch: baseBranch } = yield* initRepoWithCommit(projectCwd);
      const existingBranch = "feature/existing";
      yield* runGit(projectCwd, ["branch", existingBranch]);
      const git = yield* GitCore;
      const worktreePath = path.join(worktreeRoot, "worktree");
      const createWorktree = vi.fn((input: Parameters<typeof git.createWorktree>[0]) =>
        git.createWorktree({ ...input, path: input.path ?? worktreePath }),
      );
      const physicalGit = { createWorktree, listBranches: git.listBranches };
      return yield* Effect.promise(() =>
        withDatabase("bigbud-bootstrap-physical-", (dbPath) =>
          run({
            dbPath,
            projectCwd,
            baseBranch,
            existingBranch,
            worktreePath,
            createWorktree,
            physicalGit,
          }),
        ),
      );
    });

  const makeDispatcher = async (input: {
    readonly runtime: ReturnType<typeof createRuntime>;
    readonly physicalGit: Parameters<typeof makeDispatchBootstrapThreadCommand>[1];
    readonly failMetadataOnce?: { current: boolean };
    readonly lock?: BootstrapCommandLock;
    readonly worktreePath?: string;
  }) => {
    const engine = await engineFor(input.runtime);
    const lock = input.lock ?? (await Effect.runPromise(makeBootstrapCommandLock()));
    return {
      engine,
      dispatch: makeDispatchBootstrapThreadCommand(
        {
          ...engine,
          dispatch: (command) => {
            if (command.type === "thread.meta.update" && input.failMetadataOnce?.current) {
              input.failMetadataOnce.current = false;
              return Effect.fail(new Error("simulated stop before metadata commit") as never);
            }
            return engine.dispatch(command);
          },
        },
        input.physicalGit,
        { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
        () => Effect.void,
        () => Effect.succeed({ sequence: 0 }),
        (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
        lock,
        input.worktreePath
          ? () => ({
              path: input.worktreePath!,
              canonicalizePath: (candidate) =>
                Effect.tryPromise(() => realpath(candidate)).pipe(
                  Effect.catch(() => Effect.succeed(null)),
                ),
            })
          : undefined,
      ),
    };
  };

  describe("response loss and restart", () => {
    it.effect("returns the fully committed parent outcome without recreating Git", () =>
      withPhysicalFixture(async (fixture) => {
        const firstRuntime = createRuntime(fixture.dbPath);
        const first = await makeDispatcher({
          runtime: firstRuntime,
          physicalGit: fixture.physicalGit,
        });
        await firstRuntime.runPromise(first.engine.dispatch(projectCommand(fixture.projectCwd)));
        const accepted = await Effect.runPromise(
          first.dispatch(bootstrapCommand(fixture.projectCwd, fixture.baseBranch)),
        );
        await firstRuntime.dispose();

        const restartedRuntime = createRuntime(fixture.dbPath);
        const restarted = await makeDispatcher({
          runtime: restartedRuntime,
          physicalGit: fixture.physicalGit,
        });
        const retried = await Effect.runPromise(
          restarted.dispatch(bootstrapCommand(fixture.projectCwd, fixture.baseBranch)),
        );

        expect(retried).toEqual(accepted);
        expect(fixture.createWorktree).toHaveBeenCalledTimes(1);
        await expect(
          restartedRuntime.runPromise(
            restarted.engine.getCommandOutcome!(childCommandId("bootstrap-thread-create")),
          ),
        ).resolves.toMatchObject({ status: "accepted", aggregateId: threadId });
        await restartedRuntime.dispose();
      }),
    );

    it.effect("adopts Git created before the metadata commit after restart", () =>
      withPhysicalFixture(async (fixture) => {
        const failMetadataOnce = { current: true };
        const firstRuntime = createRuntime(fixture.dbPath);
        const first = await makeDispatcher({
          runtime: firstRuntime,
          physicalGit: fixture.physicalGit,
          failMetadataOnce,
        });
        await firstRuntime.runPromise(first.engine.dispatch(projectCommand(fixture.projectCwd)));
        await expect(
          Effect.runPromise(
            first.dispatch(bootstrapCommand(fixture.projectCwd, fixture.baseBranch)),
          ),
        ).rejects.toThrow("simulated stop before metadata commit");
        expect(fixture.createWorktree).toHaveBeenCalledTimes(1);
        await firstRuntime.dispose();

        const restartedRuntime = createRuntime(fixture.dbPath);
        const restarted = await makeDispatcher({
          runtime: restartedRuntime,
          physicalGit: fixture.physicalGit,
        });
        await Effect.runPromise(
          restarted.dispatch(bootstrapCommand(fixture.projectCwd, fixture.baseBranch)),
        );

        expect(fixture.createWorktree).toHaveBeenCalledTimes(1);
        await expect(
          restartedRuntime.runPromise(
            restarted.engine.getCommandOutcome!(childCommandId("bootstrap-thread-meta-update")),
          ),
        ).resolves.toMatchObject({ status: "accepted", aggregateId: threadId });
        await restartedRuntime.dispose();
      }),
    );

    it.effect("adopts an exact existing-branch worktree after restart", () =>
      withPhysicalFixture(async (fixture) => {
        const failMetadataOnce = { current: true };
        const firstRuntime = createRuntime(fixture.dbPath);
        const first = await makeDispatcher({
          runtime: firstRuntime,
          physicalGit: fixture.physicalGit,
          failMetadataOnce,
          worktreePath: fixture.worktreePath,
        });
        await firstRuntime.runPromise(first.engine.dispatch(projectCommand(fixture.projectCwd)));
        const command = existingBranchBootstrapCommand(fixture.projectCwd, fixture.existingBranch);
        await expect(Effect.runPromise(first.dispatch(command))).rejects.toThrow(
          "simulated stop before metadata commit",
        );
        await firstRuntime.dispose();

        const restartedRuntime = createRuntime(fixture.dbPath);
        const restarted = await makeDispatcher({
          runtime: restartedRuntime,
          physicalGit: fixture.physicalGit,
          worktreePath: fixture.worktreePath,
        });
        await Effect.runPromise(restarted.dispatch(command));

        expect(fixture.createWorktree).toHaveBeenCalledTimes(1);
        await expect(
          restartedRuntime.runPromise(
            restarted.engine.getCommandOutcome!(childCommandId("bootstrap-thread-meta-update")),
          ),
        ).resolves.toMatchObject({ status: "accepted", aggregateId: threadId });
        await restartedRuntime.dispose();
      }),
    );
  });

  it.effect("serializes overlapping retries for the same parent", () =>
    withPhysicalFixture(async (fixture) => {
      const runtime = createRuntime(fixture.dbPath);
      const transportLocks = await Effect.runPromise(makeWsRpcTransportLockBindings);
      expect(transportLocks.desktop).toBe(transportLocks.mobile);
      let signalCreateStarted!: () => void;
      let releaseCreate!: () => void;
      const createStarted = new Promise<void>((resolve) => (signalCreateStarted = resolve));
      const createRelease = new Promise<void>((resolve) => (releaseCreate = resolve));
      const gatedCreateWorktree = vi.fn(
        (input: Parameters<typeof fixture.physicalGit.createWorktree>[0]) =>
          Effect.promise(async () => {
            signalCreateStarted();
            await createRelease;
          }).pipe(Effect.flatMap(() => fixture.physicalGit.createWorktree(input))),
      );
      const physicalGit = {
        ...fixture.physicalGit,
        createWorktree: gatedCreateWorktree,
      };
      const desktop = await makeDispatcher({
        runtime,
        physicalGit,
        lock: transportLocks.desktop,
      });
      const mobile = await makeDispatcher({
        runtime,
        physicalGit,
        lock: transportLocks.mobile,
      });
      await runtime.runPromise(desktop.engine.dispatch(projectCommand(fixture.projectCwd)));
      const nextCommand = bootstrapCommand(fixture.projectCwd, fixture.baseBranch);
      const desktopResult = Effect.runPromise(desktop.dispatch(nextCommand));
      await createStarted;
      const mobileResult = Effect.runPromise(mobile.dispatch(nextCommand));
      await Promise.resolve();
      expect(gatedCreateWorktree).toHaveBeenCalledTimes(1);
      releaseCreate();
      const results = await Promise.all([desktopResult, mobileResult]);

      expect(results[1]).toEqual(results[0]);
      expect(gatedCreateWorktree).toHaveBeenCalledTimes(1);
      expect(fixture.createWorktree).toHaveBeenCalledTimes(1);
      await runtime.dispose();
    }),
  );
});
