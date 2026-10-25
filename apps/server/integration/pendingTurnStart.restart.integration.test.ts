import { DEFAULT_MODEL_BY_PROVIDER } from "@bigbud/contracts/constants/model.constant.ts";
import { CommandId, MessageId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  createRuntime,
  engineFor,
} from "../src/orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { deriveServerPaths } from "../src/startup/config.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { PROJECT_ID, THREAD_ID } from "./orchestrationEngine.integration.shared.ts";

const createdAt = "2026-10-22T00:00:00.000Z";
const model = DEFAULT_MODEL_BY_PROVIDER.codex;

const send = (id: string): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe(`send-${id}`),
  threadId: THREAD_ID,
  message: { messageId: MessageId.makeUnsafe(id), role: "user", text: id, attachments: [] },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt,
});

/** The state a crash leaves mid-start: `first` requested and gated, `second` queued behind it. */
const seedCrashedStart = (dbPath: string, workspaceDir: string) =>
  Effect.promise(async () => {
    const runtime = createRuntime(dbPath);
    try {
      const engine = await engineFor(runtime);
      const commands: ReadonlyArray<OrchestrationCommand> = [
        {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create"),
          projectId: PROJECT_ID,
          title: "Integration Project",
          workspaceRoot: workspaceDir,
          defaultModelSelection: { provider: "codex", model },
          createdAt,
        },
        {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Integration Thread",
          modelSelection: { provider: "codex", model },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: workspaceDir,
          createdAt,
        },
        send("first"),
        {
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("bound-ready"),
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        },
        send("second"),
      ];
      for (const command of commands) await runtime.runPromise(engine.dispatch(command));
      const thread = (await runtime.runPromise(engine.getReadModel())).threads[0]!;
      if (thread.pendingTurnStart?.messageId !== "first") throw new Error("seed did not gate");
    } finally {
      await runtime.dispose();
    }
  });

it.live("delivers the queue behind a start a crash orphaned, with the real reactor", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bigbud-orphan-start-" });
    const { dbPath, stateDir } = yield* deriveServerPaths(rootDir, undefined);
    const workspaceDir = path.join(rootDir, "workspace");
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* seedCrashedStart(dbPath, workspaceDir);

    // Restart: the engine settles the orphan and flushes `second` while building, before the
    // reactor subscribes. The reactor must still deliver it once and clear its gate.
    const harness = yield* makeOrchestrationIntegrationHarness({
      rootDir,
      nextSessionTurnResponses: [{ events: [], deferCompletion: true }],
      // Production runs several startup phases first, so the flush is committed by now.
      beforeReactorStart: (engine) =>
        Effect.promise(() =>
          vi.waitFor(async () => {
            const readModel = await Effect.runPromise(engine.getReadModel());
            if (readModel.threads[0]?.pendingTurnStart?.messageId !== "second") throw new Error();
          }),
        ),
    });
    try {
      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.pendingTurnStart === null && entry.session?.activeTurnId != null,
      );
      const inputs = harness.adapterHarness!.getSentTurnInputs();
      assert.equal(inputs.length, 1);
      assert.isTrue(inputs[0]!.endsWith("second"));
      assert.deepEqual(thread.queuedPrompts, []);
      assert.equal(thread.session?.activeTurnId, TurnId.makeUnsafe("turn-1"));
      assert.deepEqual(
        thread.messages.filter((message) => message.role === "user").map((message) => message.id),
        ["first", "second"],
      );
    } finally {
      yield* harness.dispose;
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
