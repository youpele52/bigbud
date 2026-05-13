import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationReadModel,
  ProviderRuntimeEvent,
  ProviderSession,
  ServerSettings,
} from "@bigbud/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProviderService, type ProviderServiceShape } from "../../Services/ProviderService.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../../orchestration/Services/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { makeHandleStdoutEvent } from "./Adapter.stream.ts";
import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const emittedEvents: ProviderRuntimeEvent[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    startSessionFresh: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([] as ProviderSession[]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const publish = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Effect.sync(() => {
      emittedEvents.push(...events);
    }).pipe(Effect.andThen(PubSub.publishAll(runtimeEventPubSub, events)), Effect.asVoid);

  return {
    emittedEvents,
    publish,
    service,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: PiRuntimeTestThread) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<PiRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for projected Pi thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type PiRuntimeTestThread = OrchestrationReadModel["threads"][number];
type PiRuntimeTestMessage = PiRuntimeTestThread["messages"][number];

describe("PiAdapter stream ingestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  let workspaceRoot: string | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    workspaceRoot = null;
  });

  it("projects live assistant text from Pi message_update deltas before completion", async () => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-pi-stream-"));
    fs.mkdirSync(path.join(workspaceRoot, ".git"));

    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer({ enableAssistantStreaming: true })),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));

    const createdAt = "2026-05-12T12:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Pi Project",
        workspaceRoot,
        defaultModelSelection: {
          provider: "pi",
          model: "sonnet",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: asThreadId("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Pi Thread",
        modelSelection: {
          provider: "pi",
          model: "sonnet",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "pi",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-pi"),
          reason: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    let eventSequence = 0;
    const sessions = new Map<ThreadId, ActivePiSession>();
    const makeSyntheticEvent: PiSyntheticEventFn = (threadId, type, payload, extra) =>
      Effect.succeed({
        eventId: asEventId(`synthetic-${++eventSequence}`),
        provider: "pi",
        threadId,
        createdAt,
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
        ...(extra?.itemId ? { itemId: extra.itemId as never } : {}),
        ...(extra?.requestId ? { requestId: extra.requestId as never } : {}),
        type,
        payload,
      } as unknown as Extract<ProviderRuntimeEvent, { type: typeof type }>);

    const handleStdoutEvent = makeHandleStdoutEvent({
      emit: provider.publish,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: asEventId(`pi-runtime-${++eventSequence}`),
          createdAt,
        }),
      makeSyntheticEvent,
      runPromise: Effect.runPromise,
      sessions,
      writeNativeEvent: () => Effect.void,
    });

    const session: ActivePiSession = {
      process: {
        child: {} as never,
        command: "pi",
        args: [],
        stderrTail: () => "",
        request: async () => {
          throw new Error("unused");
        },
        write: async () => undefined,
        subscribe: () => () => undefined,
        stop: async () => undefined,
      },
      threadId: asThreadId("thread-1"),
      createdAt,
      runtimeMode: "approval-required",
      pendingUserInputs: new Map(),
      turns: [{ id: asTurnId("turn-pi"), items: [] }],
      unsubscribe: () => undefined,
      cwd: workspaceRoot,
      model: "sonnet",
      providerID: "anthropic",
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      activeTurnId: asTurnId("turn-pi"),
      pendingTurnEnd: undefined,
      lastUsage: undefined,
      sessionId: "pi-session-1",
      sessionFile: undefined,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
    };
    sessions.set(session.threadId, session);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_start",
        message: { role: "assistant" },
      }),
    );
    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello Pi",
        },
      }),
    );

    const liveThread = await waitForThread(engine, (thread) =>
      thread.messages.some(
        (message: PiRuntimeTestMessage) =>
          message.role === "assistant" && message.streaming && message.text === "Hello Pi",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (message: PiRuntimeTestMessage) => message.role === "assistant",
    );
    expect(liveMessage?.streaming).toBe(true);
    expect(provider.emittedEvents.map((event) => event.type)).toContain("content.delta");

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello Pi" }],
        },
      }),
    );

    const finalThread = await waitForThread(engine, (thread) =>
      thread.messages.some(
        (message: PiRuntimeTestMessage) =>
          message.role === "assistant" && !message.streaming && message.text === "Hello Pi",
      ),
    );
    const finalMessage = finalThread.messages.find(
      (message: PiRuntimeTestMessage) => message.role === "assistant",
    );
    expect(finalMessage?.streaming).toBe(false);
    expect(finalMessage?.text).toBe("Hello Pi");
    expect(provider.emittedEvents.map((event) => event.type)).toContain("item.completed");
  });

  it("defers Pi turn completion until an open assistant message ends", async () => {
    const createdAt = "2026-05-12T12:00:00.000Z";
    const provider = createProviderServiceHarness();
    let eventSequence = 0;
    const sessions = new Map<ThreadId, ActivePiSession>();
    const makeSyntheticEvent: PiSyntheticEventFn = (threadId, type, payload, extra) =>
      Effect.succeed({
        eventId: asEventId(`synthetic-${++eventSequence}`),
        provider: "pi",
        threadId,
        createdAt,
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
        ...(extra?.itemId ? { itemId: extra.itemId as never } : {}),
        ...(extra?.requestId ? { requestId: extra.requestId as never } : {}),
        type,
        payload,
      } as unknown as Extract<ProviderRuntimeEvent, { type: typeof type }>);
    const handleStdoutEvent = makeHandleStdoutEvent({
      emit: provider.publish,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: asEventId(`pi-runtime-${++eventSequence}`),
          createdAt,
        }),
      makeSyntheticEvent,
      runPromise: Effect.runPromise,
      sessions,
      writeNativeEvent: () => Effect.void,
    });
    const session: ActivePiSession = {
      process: {
        child: {} as never,
        command: "pi",
        args: [],
        stderrTail: () => "",
        request: async () => {
          throw new Error("unused");
        },
        write: async () => undefined,
        subscribe: () => () => undefined,
        stop: async () => undefined,
      },
      threadId: asThreadId("thread-1"),
      createdAt,
      runtimeMode: "approval-required",
      pendingUserInputs: new Map(),
      turns: [{ id: asTurnId("turn-pi"), items: [] }],
      unsubscribe: () => undefined,
      cwd: undefined,
      model: "sonnet",
      providerID: "anthropic",
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      activeTurnId: asTurnId("turn-pi"),
      pendingTurnEnd: undefined,
      lastUsage: undefined,
      sessionId: "pi-session-1",
      sessionFile: undefined,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
    };
    sessions.set(session.threadId, session);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_start",
        message: { role: "assistant" },
      }),
    );
    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "turn_end",
        message: { stopReason: "completed" },
      }),
    );

    expect(session.activeTurnId).toBe(asTurnId("turn-pi"));
    expect(session.pendingTurnEnd).toBeDefined();
    expect(provider.emittedEvents.some((event) => event.type === "turn.completed")).toBe(false);
    expect(
      provider.emittedEvents.some(
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      ),
    ).toBe(false);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "still streaming",
        },
      }),
    );
    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "still streaming" }],
        },
      }),
    );

    expect(session.activeTurnId).toBeUndefined();
    expect(session.pendingTurnEnd).toBeUndefined();
    expect(provider.emittedEvents.map((event) => event.type)).toContain("item.completed");
    expect(provider.emittedEvents.map((event) => event.type)).toContain("turn.completed");
    expect(
      provider.emittedEvents.some(
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      ),
    ).toBe(true);
  });
});
