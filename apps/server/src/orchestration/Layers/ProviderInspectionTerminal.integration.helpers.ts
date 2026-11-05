import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@bigbud/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { vi } from "vitest";
import { createHarness } from "./CheckpointReactor.test.helpers.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ServerConfig } from "../../startup/config.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderTurnLivenessRepositoryLive } from "../../persistence/Layers/ProviderTurnLiveness.ts";
import { ProviderTurnLivenessRepository } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { ThreadRecoveryIntentRepositoryLive } from "../../persistence/Layers/ThreadRecoveryIntents.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { makeInspectionDelivery } from "../../provider/Layers/ProviderService.inspection.delivery.ts";
import { makeProcessProviderRuntimeEvent } from "../../provider/Layers/ProviderService.runtimeEvents.ts";
import {
  makeTurnLivenessOperations,
  observeProviderRuntimeEvent,
} from "../../provider/Layers/ProviderService.turnLiveness.ts";
import { makeProviderTurnSupervisor } from "./ProviderTurnSupervisor.ts";
import { makeCodexInspectActiveTurn } from "../../provider/Layers/Codex/Adapter.inspection.ts";
import type { CodexAppServerManager } from "../../codex/codexAppServerManager.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { makeInspectionAdmission } from "./ProviderInspectionTerminal.integration.admission.ts";

export const inspectionThreadId = ThreadId.makeUnsafe("thread-1");
export const inspectionTurnId = TurnId.makeUnsafe("native-inspected-turn");
export const inspectionMessageId = MessageId.makeUnsafe("accepted-user-prompt");

function journalRuntime(dbPath: string) {
  const repositories = Layer.mergeAll(
    ProviderSessionRuntimeRepositoryLive,
    ProviderTurnLivenessRepositoryLive,
    ThreadRecoveryIntentRepositoryLive,
  ).pipe(Layer.provideMerge(makeSqlitePersistenceLive(dbPath)));
  return ManagedRuntime.make(
    ProviderSessionDirectoryLive.pipe(
      Layer.provideMerge(repositories),
      Layer.provide(NodeServices.layer),
    ),
  );
}

/** Real supervisor, terminal claims, journal DB, ingestion, Git checkpoints, and recovery consumers. */
export async function createInspectionTerminalHarness(
  mode: "text" | "empty" | "failed" | "plan",
  fault?: "publication",
) {
  const h = await createHarness({ seedFilesystemCheckpoints: false });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-inspected-terminal-"));
  const dbPath = path.join(temp, "journal.sqlite");
  let durable = journalRuntime(dbPath);
  let supervisorScope: Scope.Closeable | undefined;
  let nowMs = Date.now();
  const startedAt = new Date(nowMs - 180_000).toISOString();
  const completedAt = new Date(nowMs - 30_000).toISOString();
  let publicationFailure = fault === "publication";
  let available = false;
  let nativePresent = true;
  let nativeRejected = false;
  const nativeWork = vi.fn();
  const nativeStarts = vi.fn();
  const service = h.provider.service;
  let session: ProviderSession = {
    threadId: inspectionThreadId,
    provider: "codex",
    status: "running",
    runtimeMode: "full-access",
    sessionEpoch: 0,
    activeTurnId: inspectionTurnId,
    cwd: h.cwd,
    resumeCursor: { threadId: "native" },
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const listSessions = () => Effect.succeed(nativePresent ? [session] : []);
  const confirmNative = () =>
    Effect.sync(() => {
      if (!nativePresent) return "absent" as const;
      if (nativeRejected) return "rejected" as const;
      session = {
        ...session,
        activeTurnId: undefined,
        status: mode === "failed" ? "error" : "ready",
        updatedAt: completedAt,
      };
      return "confirmed" as const;
    });
  const sendNative = () =>
    Effect.sync(() => {
      nativeWork();
      return { threadId: inspectionThreadId, turnId: TurnId.makeUnsafe("next-native-turn") };
    });
  const startNative = () =>
    Effect.sync(() => {
      nativeStarts();
      return { ...session, sessionEpoch: 1 };
    });
  Object.assign(service, {
    listSessions,
    listSessionsForReconciliation: () =>
      listSessions().pipe(
        Effect.map((sessions) => ({
          sessions,
          availableProviders: new Set(["codex"]),
          unavailableProviders: new Set(),
          directoryAvailable: true,
          diagnostics: [],
        })),
      ),
  });
  const inspect = makeCodexInspectActiveTurn({
    listSessions: () => [session],
    inspectActiveTurn: async () =>
      available
        ? {
            status: mode === "failed" ? "failed" : "completed",
            observedAt: new Date(nowMs).toISOString(),
            turn: {
              id: inspectionTurnId,
              completedAt,
              status: mode === "failed" ? "failed" : "completed",
              error: mode === "failed" ? { message: "native failed" } : null,
              items:
                mode === "empty" || mode === "failed"
                  ? []
                  : mode === "plan"
                    ? [{ id: "lost-plan", type: "plan", text: "## Durable plan\n- ship once" }]
                    : [{ id: "lost-message", type: "agentMessage", text: "durable text" }],
            },
          }
        : { status: "unavailable", observedAt: new Date(nowMs).toISOString() },
  } as unknown as CodexAppServerManager);
  Object.assign(service, {
    inspectActiveTurn: (input: { threadId: ThreadId; turnId: TurnId }) =>
      inspect(input.threadId, input.turnId),
  });

  async function attachJournal() {
    const directory = await durable.runPromise(Effect.service(ProviderSessionDirectory));
    const liveness = await durable.runPromise(Effect.service(ProviderTurnLivenessRepository));
    const process = makeProcessProviderRuntimeEvent({
      observe: (event) => observeProviderRuntimeEvent(Option.some(liveness), event),
      publish: (event) =>
        Effect.sync(() => {
          if (publicationFailure)
            throw new Error("crashed after terminal claim before publication");
          h.provider.emit(event);
        }),
    });
    const delivery = makeInspectionDelivery(directory, process);
    Object.assign(
      service,
      makeTurnLivenessOperations(Option.some(liveness)),
      delivery,
      makeInspectionAdmission(directory, {
        ...delivery,
        confirmInspectedTurn: confirmNative,
        sendTurn: sendNative,
        startSession: startNative,
        startSessionFresh: startNative,
      }),
    );
    return {
      directory,
      liveness,
      intents: await durable.runPromise(Effect.service(ThreadRecoveryIntentRepository)),
    };
  }
  let stores = await attachJournal();
  await Effect.runPromise(
    h.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("seed-running-inspection"),
      threadId: inspectionThreadId,
      session: {
        threadId: inspectionThreadId,
        providerName: "codex",
        status: "running",
        runtimeMode: "full-access",
        activeTurnId: inspectionTurnId,
        sessionEpoch: 0,
        lastError: null,
        updatedAt: startedAt,
      },
      createdAt: startedAt,
    }),
  );
  await Effect.runPromise(
    h.checkpointStore.captureCheckpoint({
      cwd: h.cwd,
      checkpointRef: checkpointRefForThreadTurn(inspectionThreadId, 0),
    }),
  );
  await Effect.runPromise(
    stores.directory.upsert({
      threadId: inspectionThreadId,
      provider: "codex",
      resumeCursor: { threadId: "native" },
      runtimePayload: { sessionEpoch: 0 },
    }),
  );
  await Effect.runPromise(
    stores.liveness.startTurn({
      threadId: inspectionThreadId,
      turnId: inspectionTurnId,
      provider: "codex",
      sessionEpoch: 0,
      startedAt,
    }),
  );
  await Effect.runPromise(
    stores.intents.recordAccepted({
      threadId: inspectionThreadId,
      messageId: inspectionMessageId,
      provider: "codex",
      createdAt: startedAt,
    }),
  );
  await durable.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE thread_recovery_intents SET turn_id = ${inspectionTurnId} WHERE thread_id = ${inspectionThreadId}`;
    }),
  );

  const ingestionRuntime = ManagedRuntime.make(
    ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, h.engine)),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const ingestion = await ingestionRuntime.runPromise(
    Effect.service(ProviderRuntimeIngestionService),
  );
  const ingestionScope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(ingestion.start().pipe(Scope.provide(ingestionScope)));

  async function startSupervisor() {
    const supervisor = await Effect.runPromise(
      makeProviderTurnSupervisor({
        nowMs: () => nowMs,
        continuationEnabled: false,
        processStartedAtMs: 0,
      }).pipe(
        Effect.provideService(OrchestrationEngineService, h.engine),
        Effect.provideService(ProviderService, service),
        Effect.provideService(ProviderRuntimeIngestionService, ingestion),
        Effect.provideService(ThreadRecoveryIntentRepository, stores.intents),
      ),
    );
    supervisorScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(supervisor.start().pipe(Scope.provide(supervisorScope)));
    return supervisor;
  }
  let supervisor = await startSupervisor();
  return {
    ...h,
    service,
    nativeWork,
    nativeStarts,
    rejectNative: () => {
      nativeRejected = true;
    },
    trySend: () =>
      Effect.runPromise(
        service
          .sendTurn({ threadId: inspectionThreadId, input: "next explicit task", sessionEpoch: 0 })
          .pipe(Effect.result),
      ),
    tryRestart: () =>
      Effect.runPromise(
        service
          .startSessionFresh(inspectionThreadId, {
            threadId: inspectionThreadId,
            provider: "codex",
            runtimeMode: "full-access",
            sessionEpoch: 1,
          })
          .pipe(Effect.result),
      ),
    partialPlan: () =>
      Effect.runPromise(
        ingestion.reconcileInspection!([
          {
            eventId: EventId.makeUnsafe("partial-native-plan"),
            provider: "codex",
            type: "turn.proposed.delta",
            threadId: inspectionThreadId,
            turnId: inspectionTurnId,
            sessionEpoch: 0,
            createdAt: startedAt,
            payload: { delta: "## Durable plan\n- partial" },
          },
        ]),
      ),
    completedAt,
    inspect: async () => {
      available = true;
      await Effect.runPromise(supervisor.runPass);
    },
    runPass: async () => {
      await Effect.runPromise(supervisor.runPass);
    },
    pending: () => Effect.runPromise(service.listInspectionTerminals!()),
    active: () => Effect.runPromise(service.listActiveTurnLiveness()),
    intent: () =>
      Effect.runPromise(
        stores.intents.get({ threadId: inspectionThreadId, messageId: inspectionMessageId }),
      ).then(Option.getOrThrow),
    advance: (ms: number) => {
      nowMs += ms;
    },
    ingestionDrain: () => Effect.runPromise(ingestion.drain),
    restartDelivery: async () => {
      available = false;
      nativePresent = false;
      publicationFailure = false;
      await Effect.runPromise(Scope.close(supervisorScope!, Exit.void));
      await Effect.runPromise(ingestion.drain);
      await h.drain();
      await durable.dispose();
      durable = journalRuntime(dbPath);
      stores = await attachJournal();
      supervisor = await startSupervisor();
      await Effect.runPromise(supervisor.runPass);
    },
    close: async () => {
      if (supervisorScope) await Effect.runPromise(Scope.close(supervisorScope, Exit.void));
      await Effect.runPromise(Scope.close(ingestionScope, Exit.void));
      await ingestionRuntime.dispose();
      await durable.dispose();
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

export async function waitInspectionDelivery(
  h: Awaited<ReturnType<typeof createInspectionTerminalHarness>>,
) {
  const deadline = Date.now() + 4000;
  while ((await h.pending()).length > 0) {
    await h.ingestionDrain();
    await h.drain();
    await h.runPass();
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for durable terminal consumer acknowledgements");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
