import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  createCommands,
  createRuntime,
  engineFor,
} from "./orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { buildAppUnderTest } from "./server.test.app.ts";
import { getWsServerUrl, serverTestLayer, withRetriedWsRpcClient } from "./server.test.rpc.ts";
import { toDispatchCommandError } from "./ws/wsDispatchCommandError.ts";

const projectId = ProjectId.makeUnsafe("ws-submission-project");
const threadId = ThreadId.makeUnsafe("ws-submission-thread");
const createdAt = "2026-09-11T00:00:00.000Z";
const submit = (id: string) => ({
  type: "thread.message.submit" as const,
  commandId: CommandId.makeUnsafe(`submit-${id}`),
  threadId,
  message: { messageId: MessageId.makeUnsafe(`message-${id}`), text: `Follow up ${id}` },
  delivery: "auto" as const,
  createdAt,
});

it.layer(serverTestLayer)("authenticated server-owned submission", (it) => {
  it.effect(
    "serializes two stale-idle clients and preserves busy follow-ups and the five-prompt cap",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "server-ws-submission-" });
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() => createRuntime(path.join(directory, "state.sqlite"))),
          (runtime) => Effect.promise(() => runtime.dispose()),
        );
        const engine = yield* Effect.promise(() => engineFor(runtime));
        for (const command of createCommands(projectId, [threadId]))
          yield* engine.dispatch(command);
        let dispatchCalls = 0;
        yield* buildAppUnderTest({
          config: { authToken: "submission-secret" },
          layers: {
            orchestrationEngine: engine,
            commandGateway: {
              dispatchNormalized: ({ command, context }) => {
                assert.equal(context.actor, "authenticated-user");
                assert.equal(context.authorizationScope, "authenticated-session");
                dispatchCalls++;
                return engine
                  .dispatch(command)
                  .pipe(
                    Effect.mapError((cause) =>
                      toDispatchCommandError(cause, "Failed to dispatch submission."),
                    ),
                  );
              },
            },
          },
        });
        const url = yield* getWsServerUrl("/ws?token=submission-secret");
        const dispatch = (command: ReturnType<typeof submit>) =>
          Effect.scoped(
            withRetriedWsRpcClient(url, (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
            ),
          );
        const commands = [submit("one"), submit("two")];
        yield* Effect.all(commands.map(dispatch), { concurrency: 2 });
        let replay = yield* engine.readReplay(0);
        assert.lengthOf(
          replay.events.filter((event) => event.type === "thread.turn-start-requested"),
          1,
        );
        assert.lengthOf(
          replay.events.filter((event) => event.type === "thread.prompt-queued"),
          1,
        );
        const state = (yield* engine.getReadModel()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.equal(state.session?.status, "starting");
        // Both durable outcomes replay, even though these clients still have an idle view.
        yield* Effect.all(commands.map(dispatch), { concurrency: 2 });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("active"),
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        for (const id of ["three", "four", "five", "six"]) yield* dispatch(submit(id));
        const overflow = yield* dispatch(submit("seven")).pipe(Effect.result);
        assert.equal(overflow._tag, "Failure");
        if (overflow._tag === "Failure")
          assert.include(overflow.failure.message, "at most 5 prompts");
        const after = (yield* engine.getReadModel()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.lengthOf(after.queuedPrompts ?? [], 5);
        replay = yield* engine.readReplay(0);
        assert.lengthOf(
          replay.events.filter((event) => event.type === "thread.turn-start-requested"),
          1,
        );
        assert.lengthOf(
          replay.events.filter((event) => event.type === "thread.prompt-queued"),
          5,
        );
        assert.isAtLeast(dispatchCalls, 9);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
