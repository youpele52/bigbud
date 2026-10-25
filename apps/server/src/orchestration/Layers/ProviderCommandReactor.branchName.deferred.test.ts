import fs from "node:fs";
import path from "node:path";
import { CommandId, EventId, ThreadId, DEFAULT_PROVIDER_INTERACTION_MODE } from "@bigbud/contracts";
import { Deferred, Effect, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as savedIdentity from "../../git/Layers/WorktreeSavedIdentity.ts";
import { maybeGenerateAndRenameWorktreeBranchForFirstTurn } from "./ProviderCommandReactorSessionOps.firstTurn.ts";
import { makeTextGenerationActivityHandler } from "./ProviderCommandReactorHandlers.textGeneration.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import {
  asMessageId,
  createHarness,
  makeTrackedTempDir,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
async function deferredBranch(startReactor = true) {
  const baseDir = makeTrackedTempDir("bigbud-deferred-branch-");
  const worktreePath = path.join(baseDir, "worktree");
  fs.mkdirSync(worktreePath);
  const harness = await createHarness({ baseDir, startReactor });
  harness.generateBranchName.mockReturnValue(Effect.succeed({ branch: "verified-feature" }));
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe("fixture:branch"),
      threadId,
      branch: "bigbud/1234abcd",
      worktreePath,
    }),
  );
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("fixture:send"),
      threadId,
      message: {
        messageId: asMessageId("fixture:user"),
        role: "user",
        text: "Build the feature",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: new Date().toISOString(),
    }),
  );
  if (startReactor) await waitFor(() => harness.sendTurn.mock.calls.length === 1);
  return { harness, worktreePath };
}
async function success(harness: Awaited<ReturnType<typeof createHarness>>, id: string) {
  const createdAt = new Date().toISOString();
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.activity.append",
      threadId,
      commandId: CommandId.makeUnsafe(id),
      createdAt,
      activity: {
        id: EventId.makeUnsafe(id),
        kind: "text-generation.model-succeeded",
        tone: "info",
        summary: "Verified success",
        turnId: null,
        createdAt,
        payload: { provider: "codex", model: "verified-model" },
      },
    }),
  );
}

describe("deferred worktree branch generation", () => {
  registerProviderCommandReactorTestCleanup();
  afterEach(() => vi.restoreAllMocks());
  it("does not lose success handled while the initial unverified snapshot waits on saved identity", async () => {
    const release = Deferred.makeUnsafe<void>();
    const paused = Deferred.makeUnsafe<void>();
    const { harness, worktreePath } = await deferredBranch(false);
    const readThread = harness.engine.getReadModel().pipe(Effect.map((model) => model.threads[0]));
    const services = {
      orchestrationEngine: harness.engine,
      resolveThread: () => readThread,
      serverSettingsService: {
        getSettings: Effect.succeed({ textGenerationModelSelection: null }),
      },
      git: { renameBranch: harness.renameBranch },
      gitStatusBroadcaster: { refreshLocalStatus: () => Effect.void },
      textGeneration: {
        generateBranchName: harness.generateBranchName,
        generateThreadTitle: harness.generateThreadTitle,
        generateThreadElevatorSummary: () => Effect.succeed({ summary: "Fixture summary" }),
      },
    } as unknown as SessionOpServices;
    vi.spyOn(savedIdentity, "assertSavedWorktreeIdentity").mockImplementationOnce(() =>
      Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(undefined),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeTextGenerationActivityHandler(services);
          const branch = yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn(services)({
            threadId,
            branch: "bigbud/1234abcd",
            worktreePath,
            messageText: "Build the feature",
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(paused);
          expect(harness.generateBranchName).not.toHaveBeenCalled();
          const before = (yield* readThread)!;
          expect(
            before.activities.some(
              (item) =>
                item.kind === "text-generation.deferred" &&
                (item.payload as { operation?: string }).operation === "branch",
            ),
          ).toBe(false);
          yield* Effect.promise(() => success(harness, "fixture:success-before-deferral"));
          const current = yield* readThread;
          const activity = current!.activities.find(
            (item) => item.id === "fixture:success-before-deferral",
          )!;
          yield* handle({ payload: { threadId, activity } });
          // A generated title proves the success handler ran, not merely that success was persisted.
          yield* Effect.promise(() =>
            waitFor(() => harness.generateThreadTitle.mock.calls.length === 1),
          );
          expect(harness.generateBranchName).not.toHaveBeenCalled();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(branch);
          yield* Effect.promise(() => waitFor(() => harness.renameBranch.mock.calls.length === 1));
          expect(harness.generateBranchName).toHaveBeenCalledTimes(1);
          expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
            modelSelection: { provider: "codex", model: "verified-model" },
            successfulModelSelection: { provider: "codex", model: "verified-model" },
          });
          expect(harness.renameBranch).toHaveBeenCalledTimes(1);
          expect(
            (yield* readThread)!.messages.filter((message) => message.role === "user"),
          ).toHaveLength(1);
          expect(harness.sendTurn).not.toHaveBeenCalled();
        }),
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, harness.sql),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      ),
    );
  });
  it("waits for first verified success and then generates/renames exactly once", async () => {
    const { harness, worktreePath } = await deferredBranch();
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    await success(harness, "fixture:success-1");
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    await waitFor(
      async () =>
        (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.activities.some(
          (item) =>
            item.kind === "text-generation.completed" &&
            (item.payload as { operation?: string }).operation === "branch",
        ) === true,
    );
    await success(harness, "fixture:success-2");
    await harness.drain();
    expect(harness.generateBranchName).toHaveBeenCalledTimes(1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      cwd: worktreePath,
      successfulModelSelection: { provider: "codex", model: "verified-model" },
    });
    expect(harness.renameBranch).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });
  it.each(["workspace", "custom-branch"])(
    "does not awaken stale generation after a changed %s",
    async (change) => {
      const { harness, worktreePath } = await deferredBranch();
      if (change === "workspace") {
        // Restore a deferred snapshot from an earlier workspace; do not bypass the worktree subsystem's transfer guards.
        const createdAt = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            threadId,
            commandId: CommandId.makeUnsafe("fixture:stale-workspace"),
            createdAt,
            activity: {
              id: EventId.makeUnsafe("fixture:stale-workspace"),
              kind: "text-generation.deferred",
              tone: "info",
              summary: "Earlier workspace request",
              payload: {
                operation: "branch",
                branch: "bigbud/1234abcd",
                worktreePath: `${worktreePath}-previous`,
                workspaceExecutionTargetId: "local",
              },
              turnId: null,
              createdAt,
            },
          }),
        );
      } else {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("fixture:changed"),
            threadId,
            branch: "user/custom-branch",
          }),
        );
      }
      await success(harness, "fixture:success");
      await harness.drain();
      expect(harness.generateBranchName).not.toHaveBeenCalled();
      expect(harness.renameBranch).not.toHaveBeenCalled();
    },
  );
});
