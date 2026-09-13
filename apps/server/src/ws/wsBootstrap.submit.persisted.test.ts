import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { calculateCommandPayloadDigest } from "../orchestration/commandDigest.ts";
import {
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { OrchestrationBootstrapRecipeRepositoryLive } from "../persistence/Layers/OrchestrationBootstrapRecipes.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationBootstrapRecipeRepository } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";
import { makeBootstrapCommandLock } from "./wsBootstrap.lock.ts";
import type { BootstrapGit } from "./wsBootstrap.worktree.ts";

const now = "2026-09-11T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("persisted-bootstrap-project");
const threadId = ThreadId.makeUnsafe("persisted-bootstrap-thread");
const parentId = CommandId.makeUnsafe("persisted-bootstrap-submit");
const branch = "feature/persisted-submit";
const childId = (tag: string) => CommandId.makeUnsafe(`server:${parentId}:${tag}`);
const createId = childId("bootstrap-thread-create");
const metaId = childId("bootstrap-thread-meta-update");
const prepareWorktree = { projectCwd: "/repo", baseBranch: "main", branch };

function submission(worktree: boolean) {
  return {
    type: "thread.message.submit",
    commandId: parentId,
    threadId,
    message: { messageId: MessageId.makeUnsafe("persisted-submit-message"), text: "hello" },
    delivery: "auto",
    createdAt: now,
    bootstrap: {
      createThread: {
        projectId,
        title: "Persisted submit",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      },
      ...(worktree ? { prepareWorktree } : {}),
    },
  } satisfies OrchestrationCommand;
}

function physicalFixture(dbPath: string) {
  // Git registration is simulated; the real directory permits SQL worktree identity capture.
  const worktreePath = join(dirname(dbPath), "worktree");
  let exists = false;
  const createWorktree = vi.fn<BootstrapGit["createWorktree"]>(() =>
    Effect.promise(async () => {
      await mkdir(worktreePath);
      exists = true;
      return { worktree: { branch, path: worktreePath } };
    }),
  );
  const listBranches = vi.fn<BootstrapGit["listBranches"]>(() =>
    Effect.succeed({
      branches: exists ? [{ name: branch, current: false, isDefault: false, worktreePath }] : [],
      isRepo: true,
      hasOriginRemote: false,
      nextCursor: null,
      totalCount: exists ? 1 : 0,
    }),
  );
  return { createWorktree, listBranches };
}

type Stop = "before-final" | "lost-ack" | "before-metadata";
async function open(dbPath: string, git: BootstrapGit, stop?: Stop) {
  const runtime = createRuntime(dbPath);
  const persistence = ManagedRuntime.make(
    Layer.mergeAll(
      OrchestrationBootstrapRecipeRepositoryLive,
      OrchestrationCommandReceiptRepositoryLive,
    ).pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
      Layer.provide(NodeServices.layer),
    ),
  );
  const dispose = async () => {
    await runtime.dispose();
    await persistence.dispose();
  };
  try {
    const engine = await engineFor(runtime);
    const recipes = await persistence.runPromise(
      Effect.service(OrchestrationBootstrapRecipeRepository),
    );
    const lock = await Effect.runPromise(makeBootstrapCommandLock());
    const dispatch = vi.fn((command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (
          (stop === "before-final" && command.type === "thread.message.submit") ||
          (stop === "before-metadata" && command.type === "thread.meta.update")
        ) {
          return yield* Effect.die(new Error(`simulated ${stop}`));
        }
        const result = yield* engine.dispatch(command);
        if (stop === "lost-ack" && command.type === "thread.message.submit") {
          return yield* Effect.die(new Error("simulated lost-ack"));
        }
        return result;
      }),
    );
    const setup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
    const bootstrap = makeDispatchBootstrapThreadCommand(
      { ...engine, dispatch },
      git,
      { runForThread: setup },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (id, tag) => CommandId.makeUnsafe(`server:${id}:${tag}`),
      lock,
      undefined,
      recipes,
    );
    return {
      dispose,
      dispatch,
      setup,
      submit: (command: ReturnType<typeof submission>) => runtime.runPromise(bootstrap(command)),
      outcome: () => runtime.runPromise(engine.getCommandOutcome!(parentId)),
      createProject: () =>
        runtime.runPromise(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("persisted-bootstrap-project-create"),
            projectId,
            title: "Bootstrap project",
            workspaceRoot: "/repo",
            defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
            createdAt: now,
          }),
        ),
      persisted: () =>
        persistence.runPromise(
          Effect.gen(function* () {
            const receipts = yield* OrchestrationCommandReceiptRepository;
            const sql = yield* SqlClient.SqlClient;
            const recipe = Option.getOrThrow(yield* recipes.getByParentCommandId(parentId));
            const [parent, create, meta] = yield* Effect.forEach(
              [parentId, createId, metaId],
              (commandId) =>
                receipts.getByCommandId({ commandId }).pipe(Effect.map(Option.getOrUndefined)),
            );
            const events = yield* sql<{
              commandId: string;
              type: string;
              payload: string;
              sequence: number;
            }>`
          SELECT command_id AS "commandId", event_type AS "type", payload_json AS "payload", sequence
          FROM orchestration_events WHERE command_id IN (${parentId}, ${createId}, ${metaId})
          ORDER BY sequence
        `;
            return { recipe, parent, create, meta, events };
          }),
        ),
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

type Persisted = Awaited<ReturnType<Awaited<ReturnType<typeof open>>["persisted"]>>;
function expectRecipe(state: Persisted, command: ReturnType<typeof submission>) {
  const digest = calculateCommandPayloadDigest(command);
  expect(state.recipe).toMatchObject({
    parentCommandId: parentId,
    recipeVersion: "bootstrap-submission/v1",
    projectId,
    originalPayloadDigestVersion: digest.version,
    originalPayloadDigest: digest.digest,
    projectCwd: command.bootstrap.prepareWorktree ? "/repo" : null,
    baseBranch: command.bootstrap.prepareWorktree ? "main" : null,
    requestedBranch: command.bootstrap.prepareWorktree ? branch : null,
  });
}

function expectAccepted(state: Persisted, command: ReturnType<typeof submission>) {
  expectRecipe(state, command);
  const { bootstrap: _bootstrap, ...finalCommand } = command;
  const digest = calculateCommandPayloadDigest(finalCommand);
  expect(state.parent).toMatchObject({
    commandId: parentId,
    status: "accepted",
    aggregateKind: "thread",
    aggregateId: threadId,
    payloadDigestVersion: digest.version,
    payloadDigest: digest.digest,
  });
  expect(state.create).toMatchObject({
    commandId: createId,
    status: "accepted",
    aggregateId: threadId,
  });
  if (command.bootstrap.prepareWorktree) {
    expect(state.meta).toMatchObject({
      commandId: metaId,
      status: "accepted",
      aggregateId: threadId,
    });
  } else expect(state.meta).toBeUndefined();
  const parentEvents = state.events.filter((event) => event.commandId === parentId);
  expect(parentEvents.map((event) => event.type)).toEqual([
    "thread.message-sent",
    "thread.turn-start-requested",
  ]);
  expect(JSON.parse(parentEvents[0]!.payload)).toMatchObject({
    messageId: command.message.messageId,
    text: "hello",
  });
  expect(state.events.filter((event) => event.commandId === createId)).toHaveLength(1);
  expect(state.events.filter((event) => event.commandId === metaId)).toHaveLength(
    command.bootstrap.prepareWorktree ? 1 : 0,
  );
}

const modes = [false, true] as const;
describe("bootstrap submit with durable recipes and receipts across restart", () => {
  it.each(modes)(
    "replays a lost parent acknowledgment unchanged (worktree: %s)",
    async (worktree) => {
      await withDatabase("bigbud-submit-replay-", async (dbPath) => {
        const git = physicalFixture(dbPath);
        const command = submission(worktree);
        let before!: Persisted;
        const first = await open(dbPath, git, "lost-ack");
        try {
          await first.createProject();
          await expect(first.submit(command)).rejects.toThrow("simulated lost-ack");
          before = await first.persisted();
          expectAccepted(before, command);
          expect(first.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
            type: "thread.message.submit",
            commandId: parentId,
          });
          expect(first.dispatch.mock.calls.at(-1)?.[0]).not.toHaveProperty("bootstrap");
        } finally {
          await first.dispose();
        }
        const restarted = await open(dbPath, git);
        try {
          await expect(restarted.outcome()).resolves.toMatchObject({
            status: "accepted",
            resultSequence: before.parent!.resultSequence,
          });
          await expect(restarted.submit(command)).resolves.toEqual({
            sequence: before.parent!.resultSequence,
          });
          expect(await restarted.persisted()).toEqual(before);
          expect(restarted.dispatch.mock.calls.map(([next]) => next.type)).toEqual([
            "thread.message.submit",
          ]);
          expect(git.createWorktree).toHaveBeenCalledTimes(worktree ? 1 : 0);
          expect(restarted.setup).not.toHaveBeenCalled();
        } finally {
          await restarted.dispose();
        }
      });
    },
  );

  it.each(
    modes.flatMap((worktree) =>
      ["title", "setup", "worktree"].map((field) => ({ worktree, field })),
    ),
  )("rejects changed $field after restart (worktree: $worktree)", async ({ worktree, field }) => {
    await withDatabase("bigbud-submit-conflict-", async (dbPath) => {
      const git = physicalFixture(dbPath);
      const command = submission(worktree);
      let before!: Persisted;
      const first = await open(dbPath, git);
      try {
        await first.createProject();
        await first.submit(command);
        before = await first.persisted();
        expectAccepted(before, command);
      } finally {
        await first.dispose();
      }
      const restarted = await open(dbPath, git);
      try {
        const changed = {
          ...command,
          bootstrap: {
            ...command.bootstrap,
            ...(field === "title"
              ? { createThread: { ...command.bootstrap.createThread, title: "changed" } }
              : {}),
            ...(field === "setup" ? { runSetupScript: true } : {}),
            ...(field === "worktree"
              ? { prepareWorktree: { ...prepareWorktree, branch: "feature/changed" } }
              : {}),
          },
        };
        await expect(restarted.submit(changed)).rejects.toMatchObject({
          code: "command_id_conflict",
        });
        expect(restarted.dispatch).not.toHaveBeenCalled();
        expect(restarted.setup).not.toHaveBeenCalled();
        expect(git.createWorktree).toHaveBeenCalledTimes(worktree ? 1 : 0);
        expect(await restarted.persisted()).toEqual(before);
        await expect(restarted.submit(command)).resolves.toEqual({
          sequence: before.parent!.resultSequence,
        });
      } finally {
        await restarted.dispose();
      }
    });
  });

  it.each([
    { worktree: false, stop: "before-final" },
    { worktree: true, stop: "before-final" },
    { worktree: true, stop: "before-metadata" },
  ] as const)(
    "recovers $stop with stable child identities (worktree: $worktree)",
    async ({ worktree, stop }) => {
      await withDatabase("bigbud-submit-resume-", async (dbPath) => {
        const git = physicalFixture(dbPath);
        const command = submission(worktree);
        let before!: Persisted;
        const first = await open(dbPath, git, stop);
        try {
          await first.createProject();
          await expect(first.submit(command)).rejects.toThrow(`simulated ${stop}`);
          await expect(first.outcome()).resolves.toMatchObject({ status: "unknown" });
          before = await first.persisted();
          expectRecipe(before, command);
          expect(before.parent).toBeUndefined();
          expect(before.create).toMatchObject({ commandId: createId, status: "accepted" });
          expect(before.events.filter((event) => event.commandId === parentId)).toEqual([]);
          if (stop === "before-metadata") expect(before.meta).toBeUndefined();
          else if (worktree)
            expect(before.meta).toMatchObject({ commandId: metaId, status: "accepted" });
        } finally {
          await first.dispose();
        }
        const restarted = await open(dbPath, git);
        try {
          const accepted = await restarted.submit(command);
          const after = await restarted.persisted();
          expectAccepted(after, command);
          expect(after.recipe).toEqual(before.recipe);
          expect(after.create).toEqual(before.create);
          if (before.meta) expect(after.meta).toEqual(before.meta);
          expect(after.events.slice(0, before.events.length)).toEqual(before.events);
          expect(restarted.dispatch.mock.calls.map(([next]) => next.type)).toEqual(
            stop === "before-metadata"
              ? ["thread.meta.update", "thread.message.submit"]
              : ["thread.message.submit"],
          );
          expect(restarted.dispatch.mock.calls.at(-1)?.[0]).not.toHaveProperty("bootstrap");
          expect(git.createWorktree).toHaveBeenCalledTimes(worktree ? 1 : 0);
          await expect(restarted.submit(command)).resolves.toEqual(accepted);
          expect(await restarted.persisted()).toEqual(after);
        } finally {
          await restarted.dispose();
        }
      });
    },
  );
});
