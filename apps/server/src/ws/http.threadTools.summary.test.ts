import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, expect } from "vitest";
import { join } from "node:path";
import { getHttpServerUrl, serverTestLayer } from "../server.test.rpc.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { deriveServerPaths, ServerConfig } from "../startup/config.ts";
import { threadOrchestrationToolsRouteLayer } from "./http.threadTools.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";

afterEach(() => setThreadOrchestrationToolDispatcher(null));

it.layer(serverTestLayer)("authenticated own-thread summary HTTP", (it) => {
  it.effect(
    "binds the caller to its token, rejects targeting/extra arguments and replays canonical receipts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "canonical-summary-" });
        const { stateDir } = yield* deriveServerPaths(baseDir, undefined);
        const runtime = createRuntime(join(baseDir, "summary.sqlite"));
        yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
        const engine = yield* Effect.promise(() => engineFor(runtime));
        const caller = ThreadId.makeUnsafe("summary-caller");
        const other = ThreadId.makeUnsafe("summary-other");
        for (const command of createCommands(ProjectId.makeUnsafe("summary-project"), [
          caller,
          other,
        ]))
          yield* engine.dispatch(command);
        const token = "owned-summary-fixture-token";
        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({ stateDir, threadId: caller, token }),
        );
        yield* Layer.build(
          HttpRouter.serve(threadOrchestrationToolsRouteLayer, {
            disableListenLog: true,
            disableLogger: true,
          }).pipe(
            Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
            Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
          ),
        );
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const post = (body: Record<string, unknown> = {}, auth = token) =>
          Effect.promise(async () => {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "x-bigbud-thread-tool-token": auth },
              body: JSON.stringify({
                action: "set_elevator_summary",
                threadId: caller,
                summary: "  Explicit   purpose\nignored",
                invocationId: "summary-call",
                sourceMessageId: "source",
                ...body,
              }),
            });
            return {
              status: response.status,
              body: (await response.json()) as Record<string, unknown>,
            };
          });
        expect((yield* post({}, "wrong-token")).status).toBe(401);
        expect((yield* post({}, "")).status).toBe(401);
        expect((yield* post({ threadId: other })).status).toBe(401);
        for (const body of [
          { targetThreadId: caller },
          { targetThreadId: other },
          { callerThreadId: other },
          { threadId: undefined },
          { summary: undefined },
          { summary: 1 },
          { summary: " " },
          { invocationId: " " },
          { sourceMessageId: " " },
          { sourceMessageId: " source " },
          { unknownArgument: true },
          { title: "not rename" },
        ])
          expect((yield* post(body)).status, JSON.stringify(body)).toBe(400);
        const accepted = yield* post();
        expect(accepted).toMatchObject({
          status: 200,
          body: {
            ok: true,
            threadId: caller,
            summary: "Explicit purpose",
            commandId: expect.any(String),
          },
        });
        const snapshot = yield* engine.getReadModel();
        expect(snapshot.threads.find((thread) => thread.id === caller)?.elevatorSummary).toBe(
          "Explicit purpose",
        );
        expect(snapshot.threads.find((thread) => thread.id === other)?.elevatorSummary).not.toBe(
          "Explicit purpose",
        );
        expect((yield* post()).body).toEqual(accepted.body);
        expect((yield* engine.getReadModel()).snapshotSequence).toBe(snapshot.snapshotSequence);
        expect((yield* post({ summary: "Changed payload" })).status).toBe(400);
      }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
