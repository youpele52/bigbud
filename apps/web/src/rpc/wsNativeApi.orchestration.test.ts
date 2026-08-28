import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  emitEvent,
  orchestrationEventListeners,
  rpcClientMock,
  terminalEventListeners,
} from "./wsNativeApi.test.helpers";

describe("wsNativeApi — orchestration", () => {
  it("recovers the verified cursor across renderer reload before replaying the next ordered events", async () => {
    const { createWsNativeApi, __resetWsNativeApiForTests } = await import("./wsNativeApi");
    const consumerId = "consumer-reload";
    const storage = new Map<string, string>([
      ["bigbud:orchestration-delivery-consumer", consumerId],
    ]);
    const browserStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    } as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: browserStorage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: browserStorage });

    rpcClientMock.orchestration.acknowledgeDelivery.mockResolvedValue({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 10,
    });
    const firstApi = createWsNativeApi();
    await firstApi.orchestration.acknowledgeDelivery({
      batchId: "batch-10",
      consumerId,
      consumerGeneration: 1,
      receivedThroughSequence: 10,
      appliedThroughSequence: 10,
      applicationDurationMs: 3,
    });
    expect(storage.get("bigbud:orchestration-delivery-cursor:consumer-reload")).toBe("10");

    __resetWsNativeApiForTests();
    orchestrationEventListeners.clear();
    const reloadedApi = createWsNativeApi();
    const deliveredSequences: number[] = [];
    reloadedApi.orchestration.onDomainEvent((batch) => {
      if (batch.type === "batch") {
        deliveredSequences.push(...batch.events.map((event) => event.sequence));
      }
    });

    const subscriptionInput = rpcClientMock.orchestration.onDomainEvent.mock.calls.at(-1)?.[0] as
      | (() => { consumerId: string; appliedSequence: number })
      | undefined;
    expect(subscriptionInput?.()).toEqual({ consumerId, appliedSequence: 10 });

    const replayEvents = [11, 12].map((sequence) => ({ sequence })) as never;
    emitEvent(orchestrationEventListeners, {
      type: "batch",
      route: "direct-unmanaged",
      consumerId,
      consumerGeneration: 2,
      serverEpoch: "epoch-1",
      subscriptionGeneration: 2,
      batchId: "batch-replay",
      events: replayEvents,
    });
    expect(deliveredSequences).toEqual([11, 12]);
    expect(new Set(deliveredSequences).size).toBe(deliveredSequences.length);
  });

  it("forwards terminal and orchestration stream events", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitEvent(terminalEventListeners, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    const deliveryBatch = {
      type: "batch",
      route: "direct-unmanaged",
      consumerId: "consumer-1",
      consumerGeneration: 1,
      serverEpoch: "epoch-1",
      subscriptionGeneration: 1,
      batchId: "batch-1",
      events: [orchestrationEvent],
    } as const;
    emitEvent(orchestrationEventListeners, deliveryBatch);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledWith(deliveryBatch);
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    rpcClientMock.orchestration.dispatchCommand.mockResolvedValue({ sequence: 1 });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(rpcClientMock.orchestration.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it("forwards full-thread diff requests to the orchestration RPC", async () => {
    rpcClientMock.orchestration.getFullThreadDiff.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(rpcClientMock.orchestration.getFullThreadDiff).toHaveBeenCalledWith({
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards bounded catalog and selected-detail requests", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");

    await api.orchestration.getSidebarThreadCatalog();
    await api.orchestration.getStartupProjectCatalog({
      scope: "local",
      limit: 2,
      priorityProjectId: projectId,
    });
    await api.orchestration.getProjectThreadSummaries({
      projectId,
      limit: 5,
      priorityThreadId: threadId,
    });
    await api.orchestration.getSelectedThreadDetail({ threadId });

    expect(rpcClientMock.orchestration.getSidebarThreadCatalog).toHaveBeenCalledWith({});
    expect(rpcClientMock.orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      scope: "local",
      limit: 2,
      priorityProjectId: projectId,
    });
    expect(rpcClientMock.orchestration.getProjectThreadSummaries).toHaveBeenCalledWith({
      projectId,
      limit: 5,
      priorityThreadId: threadId,
    });
    expect(rpcClientMock.orchestration.getSelectedThreadDetail).toHaveBeenCalledWith({ threadId });
  });

  it("preserves typed replay range metadata", async () => {
    const replay = {
      requestedFromSequenceExclusive: 4,
      retainedFromSequenceExclusive: 0,
      earliestAvailableSequence: 1,
      latestSequence: 4,
      availability: "available" as const,
      complete: true,
      events: [],
    };
    rpcClientMock.orchestration.replayEvents.mockResolvedValue(replay);
    const { createWsNativeApi } = await import("./wsNativeApi");

    await expect(createWsNativeApi().orchestration.replayEvents(4)).resolves.toEqual(replay);
    expect(rpcClientMock.orchestration.replayEvents).toHaveBeenCalledWith({
      fromSequenceExclusive: 4,
    });
  });

  it("returns authoritative thread ownership from the orchestration RPC", async () => {
    const threadId = ThreadId.makeUnsafe("thread-owned");
    rpcClientMock.orchestration.getThreadOwnership.mockResolvedValue({
      threadId,
      projectId: ProjectId.makeUnsafe("project-1"),
      status: "archived",
      serverEpoch: "server-1",
      canonicalRevision: 12,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    await expect(
      createWsNativeApi().orchestration.resolveThreadOwnership({ threadId }),
    ).resolves.toMatchObject({ status: "archived", canonicalRevision: 12 });
  });

  it("returns durable command outcomes from the orchestration RPC", async () => {
    const commandId = CommandId.makeUnsafe("command-outcome");
    rpcClientMock.orchestration.getCommandOutcome.mockResolvedValue({
      commandId,
      status: "unknown",
      serverEpoch: "server-1",
      canonicalRevision: 12,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    await expect(
      createWsNativeApi().orchestration.getCommandOutcome({ commandId }),
    ).resolves.toEqual({
      commandId,
      status: "unknown",
      serverEpoch: "server-1",
      canonicalRevision: 12,
    });
  });

  it("returns unavailable instead of guessing absence when ownership lookup fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-unavailable");
    rpcClientMock.orchestration.getThreadOwnership.mockRejectedValue(
      new Error("server disconnected"),
    );
    const { createWsNativeApi } = await import("./wsNativeApi");

    await expect(
      createWsNativeApi().orchestration.resolveThreadOwnership({ threadId }),
    ).resolves.toEqual({
      threadId,
      status: "unavailable",
      ownership: "unconfirmed",
      reason: "server disconnected",
    });
  });
});
