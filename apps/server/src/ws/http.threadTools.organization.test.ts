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

it.layer(serverTestLayer)("authenticated Inyosira organization HTTP", (it) => {
  it.effect(
    "moves and snoozes authorized targets, replays invocations, and never archives on unmatched actions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "inyosira-tools-" });
        const { stateDir } = yield* deriveServerPaths(baseDir, undefined);
        const runtime = createRuntime(join(baseDir, "inyosira.sqlite"));
        yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
        const engine = yield* Effect.promise(() => engineFor(runtime));
        const caller = ThreadId.makeUnsafe("inyosira-caller");
        const target = ThreadId.makeUnsafe("inyosira-target");
        const foreign = ThreadId.makeUnsafe("inyosira-foreign");
        for (const command of [
          ...createCommands(ProjectId.makeUnsafe("inyosira-project"), [caller, target]),
          ...createCommands(ProjectId.makeUnsafe("inyosira-foreign-project"), [foreign]),
        ])
          yield* engine.dispatch(command);
        const token = "inyosira-fixture-token";
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
        const post = (body: Record<string, unknown>) =>
          Effect.promise(async () => {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "x-bigbud-thread-tool-token": token },
              body: JSON.stringify({ threadId: caller, ...body }),
            });
            return {
              status: response.status,
              body: (await response.json()) as { result?: Record<string, unknown> },
            };
          });
        const organizationOf = (threadId: ThreadId) =>
          engine
            .getReadModel()
            .pipe(
              Effect.map(
                (model) => model.threads.find((thread) => thread.id === threadId)?.organization,
              ),
            );

        // Unmatched or malformed organization calls must never fall through to archive.
        expect((yield* post({ action: "move" })).status).toBe(400);
        expect((yield* post({ action: "move", organizationState: "archived" })).status).toBe(400);
        expect((yield* post({ action: "snooze", durationMinutes: 1 })).status).toBe(400);
        expect((yield* post({ action: "snooze", durationMinutes: 1441 })).status).toBe(400);
        expect(
          (yield* post({ action: "move", organizationState: "done", targetThreadId: foreign }))
            .status,
        ).toBe(400);
        expect(
          (yield* engine.getReadModel()).threads.every((thread) => thread.archivedAt === null),
        ).toBe(true);

        const stable = { action: "move", organizationState: "done", invocationId: "call-1" };
        const moved = yield* post(stable);
        expect(moved.status).toBe(200);
        expect(moved.body.result).toMatchObject({
          threadId: caller,
          changed: true,
          organization: { state: "done", revision: 1 },
        });
        const replay = yield* post(stable);
        expect(replay.body.result).toMatchObject({ changed: false, organization: { revision: 1 } });

        // A repeated same-state move renews the intentional period; its retry replays it once.
        const renew = { action: "move", organizationState: "done", invocationId: "call-2" };
        expect((yield* post(renew)).body.result).toMatchObject({
          changed: true,
          organization: { state: "done", revision: 2 },
        });
        const renewReplay = yield* post(renew);
        expect(renewReplay.status).toBe(200);
        expect(renewReplay.body.result).toMatchObject({
          changed: false,
          organization: { revision: 2 },
        });

        const snoozed = yield* post({
          action: "snooze",
          durationMinutes: 30,
          targetThreadId: target,
          invocationId: "call-3",
        });
        expect(snoozed.status).toBe(200);
        expect(yield* organizationOf(target)).toMatchObject({
          state: "later",
          snooze: { id: expect.any(String) },
        });
        expect(yield* organizationOf(caller)).toMatchObject({ state: "done" });
        expect(
          (yield* engine.getReadModel()).threads.every((thread) => thread.archivedAt === null),
        ).toBe(true);
      }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
