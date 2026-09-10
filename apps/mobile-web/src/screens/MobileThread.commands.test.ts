import { CommandId, MessageId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildMobileExistingThreadTurnStartCommand } from "./MobileThread.commands";
import { createMobileThreadCommands } from "./MobileThread.commands";
import { createMobileCommandDeliveryController } from "../lib/mobileCommandDelivery";

const threadId = ThreadId.makeUnsafe("thread-existing");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: "project-1" as OrchestrationThread["projectId"],
    title: "Existing thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
  } as unknown as OrchestrationThread;
}

describe("mobile existing-thread command builder", () => {
  it("uses a model-aware turn start and preserves thread modes", () => {
    const command = buildMobileExistingThreadTurnStartCommand({
      commandId: CommandId.makeUnsafe("command-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      messageId: MessageId.makeUnsafe("message-1"),
      modelSelection: { provider: "claudeAgent", model: "sonnet" },
      text: "Continue this thread",
      thread: makeThread(),
      threadId,
    });

    expect(command).toMatchObject({
      type: "thread.turn.start",
      commandId: "command-1",
      interactionMode: "plan",
      modelSelection: { provider: "claudeAgent", model: "sonnet" },
      runtimeMode: "full-access",
      message: {
        messageId: "message-1",
        role: "user",
        text: "Continue this thread",
        attachments: [],
      },
    });
    expect(command).not.toHaveProperty("bootstrap");
  });

  it("admits one existing-thread send when activation is repeated", async () => {
    let resolveDispatch: (() => void) | undefined;
    const dispatchCommand = vi.fn(
      (_command: unknown) =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const commands = createMobileThreadCommands({
      actionsAvailable: true,
      activePendingUserInput: null,
      activeUserInputAnswers: {},
      activeUserInputQuestionIndex: 0,
      client: { dispatchCommand } as never,
      clearNewThread: () => undefined,
      clearSubmittedIfRevision: () => undefined,
      delivery: createMobileCommandDeliveryController({ deadlineMs: 1_000 }),
      draftThread: null,
      isDraft: false,
      project: undefined,
      prompt: "Send once",
      recovery: null,
      refetchSnapshot: async () => undefined,
      refetchThread: async () => undefined,
      revision: 1,
      selectedModelSelection: { provider: "claudeAgent", model: "sonnet" },
      setIsRespondingToUserInput: () => undefined,
      setPendingModelSelection: () => undefined,
      setPrompt: () => undefined,
      setUserInputAnswersByRequestId: () => undefined,
      setUserInputQuestionIndexByRequestId: () => undefined,
      thread: makeThread(),
      threadId,
    });

    const first = commands.sendPrompt();
    const second = commands.sendPrompt();
    expect(dispatchCommand).toHaveBeenCalledOnce();
    resolveDispatch?.();
    await first;
    await second;
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.turn.start",
      modelSelection: { provider: "claudeAgent", model: "sonnet" },
    });
  });
});
