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
    emitEvent(orchestrationEventListeners, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
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
});
