import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import type { ProviderTurnLiveness } from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderTurnLivenessRepositoryShape } from "../../../persistence/Services/ProviderTurnLiveness.ts";
import {
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "../../../orchestration/Layers/ProviderRuntimeIngestion.test.helpers.ts";
import { superviseProviderTurns } from "../../../orchestration/Layers/ProviderTurnSupervisor.ts";
import { makeProcessProviderRuntimeEvent } from "../ProviderService.runtimeEvents.ts";
import { observeProviderRuntimeEvent } from "../ProviderService.turnLiveness.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { makeActiveTurnInspection } from "./Adapter.activeTurnInspection.ts";
import { makeTurnMethods } from "./Adapter.session.turn.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("OpenCode recovered completion integration", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("leaves terminal ownership to canonical ingestion and runs completion consumers once", async () => {
    const harness = await createHarness();
    const queuedRuntimeEvents: ProviderRuntimeEvent[] = [];
    const publishedRuntimeEvents: ProviderRuntimeEvent[] = [];
    let messagesCalls = 0;
    let syntheticOrdinal = 0;
    const stalledPoll = new Promise<never>(() => undefined);
    const client = {
      session: {
        promptAsync: async () => ({ data: {}, error: undefined }),
        messages: async () => {
          messagesCalls += 1;
          if (messagesCalls === 1) return { data: [], error: undefined };
          if (messagesCalls === 2) return stalledPoll;
          return {
            data: [
              {
                info: {
                  id: "assistant-recovered",
                  role: "assistant",
                  time: { completed: Date.now() },
                },
                parts: [{ id: "assistant-recovered-text", type: "text", text: "Recovered output" }],
              },
            ],
            error: undefined,
          };
        },
        status: async () => ({
          data: { "opencode-recovery-session": { type: "idle" } },
          error: undefined,
        }),
      },
      question: { list: async () => ({ data: [], error: undefined }) },
      permission: { list: async () => ({ data: [], error: undefined }) },
    };
    const record = {
      client,
      releaseServer: () => undefined,
      opencodeSessionId: "opencode-recovery-session",
      threadId: THREAD_ID,
      sessionEpoch: 0,
      createdAt: new Date().toISOString(),
      runtimeMode: "approval-required",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      pendingPermissions: new Map(),
      pendingUserInputs: new Map(),
      turns: [],
      sseAbortController: null,
      cwd: "/tmp/opencode-recovery",
      model: undefined,
      providerID: undefined,
      updatedAt: new Date().toISOString(),
      lastError: undefined,
      activeTurnId: undefined,
      lastUsage: undefined,
      wasRetrying: false,
      reasoningPartIds: new Set(),
      allowedTools: {},
    } as unknown as ActiveOpencodeSession;
    const { sendTurn } = makeTurnMethods({
      provider: "opencode",
      requireSession: () => Effect.succeed(record),
      syntheticEventFn: (threadId, sessionEpoch, type, payload, extra) =>
        Effect.succeed({
          eventId: EventId.makeUnsafe(`opencode-recovery-${++syntheticOrdinal}`),
          provider: "opencode",
          threadId,
          sessionEpoch,
          turnId: extra?.turnId,
          itemId: extra?.itemId,
          requestId: extra?.requestId,
          type,
          payload,
          createdAt: new Date().toISOString(),
        } as never),
      emitFn: (events) =>
        Effect.sync(() => {
          queuedRuntimeEvents.push(...events);
        }),
      teardownSessionRecord: () => Effect.void,
      serverConfig: { attachmentsDir: "/tmp/opencode-recovery-attachments" },
    });

    const turn = await Effect.runPromise(sendTurn({ threadId: THREAD_ID, input: "Recover me" }));
    await vi.waitFor(() => expect(messagesCalls).toBe(2));

    const terminalOwners: string[] = [];
    let terminalClaimed = false;
    const claimTerminal = (owner: "supervisor" | "canonical") =>
      Effect.sync(() => {
        terminalOwners.push(owner);
        if (terminalClaimed) return false;
        terminalClaimed = true;
        return true;
      });
    const livenessRepository = {
      observeEvent: () => Effect.void,
      claimTerminal: () => claimTerminal("canonical"),
    } as unknown as ProviderTurnLivenessRepositoryShape;
    const processRuntimeEvent = makeProcessProviderRuntimeEvent({
      observe: (event) => observeProviderRuntimeEvent(Option.some(livenessRepository), event),
      publish: (event) =>
        Effect.sync(() => {
          publishedRuntimeEvents.push(event);
          harness.emit(event);
        }),
    });

    harness.setProviderSession({
      provider: "opencode",
      status: "running",
      runtimeMode: "approval-required",
      threadId: THREAD_ID,
      activeTurnId: turn.turnId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    for (const event of queuedRuntimeEvents.splice(0)) {
      await Effect.runPromise(processRuntimeEvent(event));
    }
    const runningThread = await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === turn.turnId,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe("queue-after-opencode-recovery"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("queued-after-opencode-recovery"),
          text: "Continue after recovery",
        },
        delivery: "queue",
        createdAt: new Date().toISOString(),
      }),
    );

    const liveness: ProviderTurnLiveness = {
      threadId: THREAD_ID,
      turnId: turn.turnId,
      provider: "opencode",
      sessionEpoch: runningThread.session?.sessionEpoch ?? 0,
      turnStartedAt: new Date().toISOString(),
      lastRuntimeEventAt: new Date().toISOString(),
      lastMeaningfulProgressAt: new Date(Date.now() - 100_000).toISOString(),
      lastInspectionAt: null,
      inspectionStatus: "idle",
      consecutiveInspectionFailures: 0,
      terminalAt: null,
    };
    const inspect = makeActiveTurnInspection({ sessions: new Map([[THREAD_ID, record]]) });
    const inspectActiveTurn = vi.fn(
      (input: { readonly threadId: ThreadId; readonly turnId: typeof turn.turnId }) =>
        inspect(input.threadId, input.turnId),
    );
    const providerService = {
      listActiveTurnLiveness: () => Effect.succeed([liveness]),
      recordTurnInspection: () => Effect.void,
      inspectActiveTurn,
      claimTurnTerminal: vi.fn(() => claimTerminal("supervisor")),
    } as unknown as ProviderServiceShape;

    await Effect.runPromise(
      superviseProviderTurns({ orchestrationEngine: harness.engine, providerService }),
    );

    expect(inspectActiveTurn).toHaveBeenCalledOnce();
    expect(messagesCalls).toBe(3);
    expect(providerService.claimTurnTerminal).not.toHaveBeenCalled();
    expect(record.promptTerminalEventsEnqueuedTurnId).toBe(turn.turnId);
    expect(queuedRuntimeEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);

    for (const event of queuedRuntimeEvents.splice(0)) {
      await Effect.runPromise(processRuntimeEvent(event));
    }
    await harness.drain();

    const settled = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (thread) => thread.id === THREAD_ID,
    )!;
    expect({
      activeTurnId: settled.session?.activeTurnId,
      status: settled.session?.status,
      queuedPrompts: settled.queuedPrompts,
      messages: settled.messages.map((message) => message.text),
    }).toEqual({
      activeTurnId: null,
      status: "ready",
      queuedPrompts: [],
      messages: expect.arrayContaining([
        "Recovered output",
        expect.stringContaining("Continue after recovery"),
      ]),
    });
    expect(settled.messages.filter((message) => message.text === "Recovered output")).toHaveLength(
      1,
    );
    expect(terminalOwners).toEqual(["canonical"]);
    expect(publishedRuntimeEvents.filter((event) => event.type === "turn.completed")).toHaveLength(
      1,
    );
  });
});
