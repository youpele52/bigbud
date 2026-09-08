import { describe, expect, it, vi } from "vitest";

import { asThreadId, createThreadControlHarness } from "./codexAppServerManager.test.helpers";

vi.mock("./codexVersionCheck", () => ({
  assertSupportedCodexCliVersion: vi.fn(),
}));

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "thread/read",
      {
        threadId: "thread_1",
        includeTurns: true,
      },
      undefined,
    );
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "thread/read",
      {
        threadId: "thread_1",
        includeTurns: true,
      },
      undefined,
    );
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("rolls back turns via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "thread/rollback",
      {
        threadId: "thread_1",
        numTurns: 2,
      },
      undefined,
    );
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [],
    });
  });

  it("steers the fenced active turn with the provider thread id and client message id", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    Object.assign(context.session, { activeTurnId: "turn_1", status: "running" });
    sendRequest.mockResolvedValue({ turnId: "turn_1" });

    await manager.steerTurn({
      threadId: asThreadId("thread_1"),
      input: "Focus on the failing test.",
      expectedTurnId: "turn_1" as never,
      clientUserMessageId: "client-message-1",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/steer",
      {
        threadId: "thread_1",
        clientUserMessageId: "client-message-1",
        input: [{ type: "text", text: "Focus on the failing test.", text_elements: [] }],
        expectedTurnId: "turn_1",
      },
      undefined,
    );
  });
});
