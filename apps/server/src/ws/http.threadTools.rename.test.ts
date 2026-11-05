import { MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, expect } from "vitest";
import { join } from "node:path";
import { getHttpServerUrl, serverTestLayer } from "../server.test.rpc.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { deriveServerPaths, ServerConfig } from "../startup/config.ts";
import { threadOrchestrationToolsRouteLayer } from "./http.threadTools.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import {
  getThreadOrchestrationToolDispatcher,
  setThreadOrchestrationToolDispatcher,
} from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import {
  isThreadTitleLocked,
  resetThreadTitleLockForTests,
} from "../orchestration-tools/ThreadTitleLock.ts";

afterEach(() => {
  setThreadOrchestrationToolDispatcher(null);
  resetThreadTitleLockForTests();
});

it.layer(serverTestLayer)("authenticated canonical rename HTTP", (it) => {
  it.effect(
    "renames eligible provider-independent targets in SQLite, rejects forged/foreign targets, and replays receipts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "canonical-rename-" });
        const { stateDir } = yield* deriveServerPaths(baseDir, undefined);
        const runtime = createRuntime(join(baseDir, "rename.sqlite"));
        yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
        const engine = yield* Effect.promise(() => engineFor(runtime));
        const caller = ThreadId.makeUnsafe("rename-caller-opencode");
        const target = ThreadId.makeUnsafe("rename-target-cursor");
        const foreign = ThreadId.makeUnsafe("rename-foreign");
        const project = ProjectId.makeUnsafe("rename-project");
        for (const command of [
          ...createCommands(project, [caller, target]).map((command) =>
            command.type === "thread.create" && command.threadId === target
              ? { ...command, modelSelection: { provider: "cursor" as const, model: "auto" } }
              : command,
          ),
          ...createCommands(ProjectId.makeUnsafe("foreign-project"), [foreign]),
        ])
          yield* engine.dispatch(command);
        const token = "owned-fixture-token";
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
        const post = (body: Record<string, unknown>, auth = token) =>
          Effect.promise(async () => {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "x-bigbud-thread-tool-token": auth },
              body: JSON.stringify({ action: "rename", threadId: caller, title: "ohno", ...body }),
            });
            return {
              status: response.status,
              body: (await response.json()) as Record<string, unknown>,
            };
          });

        expect((yield* post({ threadId: target, targetThreadId: caller })).status).toBe(401);
        expect((yield* post({ callerThreadId: foreign, targetThreadId: foreign })).status).toBe(
          400,
        );
        expect((yield* post({ targetThreadId: target }, "wrong-token")).status).toBe(401);
        for (const targetThreadId of [foreign, "missing", " "]) {
          expect((yield* post({ targetThreadId })).status).toBe(400);
        }
        for (const title of ["", " ", "x".repeat(201), 123, null]) {
          expect((yield* post({ title, targetThreadId: target })).status).toBe(400);
        }
        const stable = {
          targetThreadId: target,
          invocationId: "call-1",
          sourceMessageId: "user-1",
        };
        const accepted = yield* post(stable);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({
          ok: true,
          title: "ohno",
          threadId: target,
          commandId: expect.any(String),
        });
        expect(isThreadTitleLocked(target)).toBe(true);
        expect(isThreadTitleLocked(caller)).toBe(false);
        const snapshot = yield* engine.getReadModel();
        expect(snapshot.threads.find((thread) => thread.id === target)).toMatchObject({
          title: "ohno",
          modelSelection: { provider: "cursor" },
        });
        expect(snapshot.threads.find((thread) => thread.id === caller)?.title).not.toBe("ohno");
        expect(snapshot.threads.find((thread) => thread.id === foreign)?.title).not.toBe("ohno");
        const retry = yield* post(stable);
        expect(retry.body.commandId).toBe(accepted.body.commandId);
        expect((yield* engine.getReadModel()).snapshotSequence).toBe(snapshot.snapshotSequence);
        expect((yield* post({ ...stable, title: "changed" })).status).toBe(400);
        const events = yield* Stream.runCollect(engine.readEvents(0));
        expect(events.filter((event) => event.commandId === accepted.body.commandId)).toEqual([
          expect.objectContaining({
            type: "thread.meta-updated",
            payload: expect.objectContaining({ threadId: target, title: "ohno" }),
          }),
          expect.objectContaining({
            type: "thread.activity-appended",
            payload: expect.objectContaining({
              threadId: target,
              activity: expect.objectContaining({
                kind: "thread.title-ownership",
                payload: { source: "manual" },
              }),
            }),
          }),
        ]);
        expect((yield* post({ title: "own-title" })).status).toBe(200);
        expect(
          (yield* engine.getReadModel()).threads.find((thread) => thread.id === caller)?.title,
        ).toBe("own-title");
        const delegated = yield* getThreadOrchestrationToolDispatcher()!.createThread!({
          callerThreadId: caller,
          sourceMessageId: MessageId.makeUnsafe("delegate-source"),
          invocationId: "delegate-call",
          projectId: ProjectId.makeUnsafe("foreign-project"),
          title: "Delegated child",
          task: "Owned fixture only; no provider invocation.",
          watchForCompletion: false,
        });
        expect(
          (yield* post({ targetThreadId: delegated.childThreadId, title: "child-title" })).status,
        ).toBe(200);
        expect(
          (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === delegated.childThreadId,
          )?.title,
        ).toBe("child-title");
        expect(isThreadTitleLocked(delegated.childThreadId)).toBe(true);
      }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
