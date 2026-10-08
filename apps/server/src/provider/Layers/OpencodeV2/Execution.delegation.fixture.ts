import { Effect, Layer, ServiceMap } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { CommandId, ProjectId, ThreadId, MessageId } from "@bigbud/contracts";
import type { OpencodeV2AdapterShape } from "../../Services/OpencodeV2/Adapter.ts";
import { createOrchestrationSystem } from "../../../orchestration/Layers/OrchestrationEngine.test.helpers.ts";
import {
  getThreadOrchestrationToolDispatcher,
  setThreadOrchestrationToolDispatcher,
} from "../../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { threadOrchestrationToolsRouteLayer } from "../../../ws/http.threadTools.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

const selection = {
  provider: "opencodeV2",
  subProviderID: "bigbud-v2-fixture",
  model: "synthetic-model",
} as const;
/** Actual authenticated HTTP route + installed canonical dispatcher/engine/SQLite delegation, with a minimal committed-turn provider consumer. */
export const makeV2NativeDelegationFixture = Effect.fn("makeV2NativeDelegationFixture")(
  function* (input: { profile: string; workspace: string; parent: ThreadId }) {
    const system = yield* Effect.promise(() => createOrchestrationSystem());
    yield* Effect.addFinalizer(() => Effect.promise(() => system.dispose()));
    const projectId = ProjectId.makeUnsafe("native-delegation-project"),
      createdAt = new Date().toISOString();
    yield* Effect.promise(() =>
      system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("delegation-project"),
          projectId,
          title: "Disposable",
          workspaceRoot: input.workspace,
          defaultModelSelection: selection,
          createdAt,
        }),
      ),
    );
    yield* Effect.promise(() =>
      system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("delegation-parent"),
          threadId: input.parent,
          projectId,
          title: "Parent",
          modelSelection: selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "local",
          executionTargetId: "local",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    );
    const installed = getThreadOrchestrationToolDispatcher()!;
    if (!installed.createThread) throw new Error("real canonical child dispatcher missing");
    let adapter: OpencodeV2AdapterShape | undefined;
    const dispatched: Record<string, unknown>[] = [];
    setThreadOrchestrationToolDispatcher({
      ...installed,
      createThread: (request) =>
        Effect.gen(function* () {
          dispatched.push(request);
          const result = yield* Effect.promise(() => system.run(installed.createThread!(request)));
          if (!result.replayed) {
            if (!adapter) throw new Error("provider consumer missing");
            const readModel = yield* Effect.promise(() => system.run(system.engine.getReadModel()));
            const child = readModel.threads.find((thread) => thread.id === result.childThreadId)!;
            // Consume the real committed canonical child turn; no fabricated child IDs or responses.
            const userMessage = child.messages.find(
              (message) => message.id === request.sourceMessageId,
            );
            if (!userMessage) throw new Error("canonical child message not committed");
            yield* adapter.startSession({
              threadId: child.id,
              cwd: input.workspace,
              modelSelection: child.modelSelection,
              runtimeMode: child.runtimeMode,
              providerRuntimeExecutionTargetId: child.providerRuntimeExecutionTargetId,
              workspaceExecutionTargetId: child.workspaceExecutionTargetId,
            });
            yield* adapter.sendTurn({
              threadId: child.id,
              modelSelection: child.modelSelection,
              input: userMessage.text,
              requestMessageId: MessageId.makeUnsafe(userMessage.id),
            });
          }
          return result;
        }),
    });
    const server = yield* Layer.build(NodeHttpServer.layerTest);
    // Build route and retain exactly the same HTTP server layer instance for its actual port.
    const serving = HttpRouter.serve(threadOrchestrationToolsRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(Layer.succeedServices(server)),
      Layer.provide(Layer.succeed(OrchestrationEngineService, system.engine)),
      Layer.provide(
        Layer.succeed(ServerConfig, { stateDir: input.profile } as typeof ServerConfig.Service),
      ),
    );
    yield* Layer.build(serving);
    const bound = ServiceMap.get(server, HttpServer.HttpServer);
    const address = bound.address;
    if (address._tag !== "TcpAddress") throw new Error("expected real loopback port");
    return {
      port: address.port,
      selection,
      dispatched,
      engine: system.engine,
      run: system.run,
      bind: (value: OpencodeV2AdapterShape) => {
        adapter = value;
      },
    };
  },
);
