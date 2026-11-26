import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const threadId = ThreadId.makeUnsafe("park-test-thread");
const messageId = MessageId.makeUnsafe("already-in-transcript");
const suffixId = MessageId.makeUnsafe("later-queued");
const approval = ApprovalRequestId.makeUnsafe("approval");
const question = ApprovalRequestId.makeUnsafe("question");
const createdAt = "2026-11-23T12:00:00.000Z";
const options = {
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "full-access" as const,
};
const gate = {
  provider: "claudeAgent" as const,
  sessionEpoch: 1,
  approvalRequests: [{ requestId: approval, generation: "generation" }],
  userInputRequests: [{ requestId: question, generation: "generation" }],
};

function close(
  kind: "approval.resolved" | "user-input.resolved",
  requestId: string,
  epoch = 1,
): OrchestrationCommand {
  const id = `${kind}:${requestId}:${epoch}`;
  return {
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(id),
    threadId,
    createdAt,
    activity: {
      id: EventId.makeUnsafe(id),
      kind,
      tone: "info",
      summary: kind,
      createdAt,
      turnId: null,
      payload: {
        requestId,
        interactionProvider: "claudeAgent",
        interactionSessionEpoch: epoch,
        requestGeneration: "generation",
      },
    },
  };
}

const park: OrchestrationCommand = {
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("park"),
  threadId,
  message: { messageId, text: "Continue" },
  ...options,
  delivery: "queue",
  createdAt,
  redeliverSentMessage: true,
  pendingInteractionGate: gate,
};

function stop(): OrchestrationCommand {
  return {
    type: "thread.session.stop",
    commandId: CommandId.makeUnsafe("stop"),
    threadId,
    createdAt,
  };
}

const release = (id: string): OrchestrationCommand => ({
  type: "thread.queued-prompt.flush",
  commandId: CommandId.makeUnsafe(id),
  threadId,
  createdAt,
  messageId,
  messageIds: [messageId],
  userRelease: true,
});

describe("durable pending interaction queue fence", () => {
  it("retains a manual-recovery hold after closure and restart; only removal discards it", () =>
    withDatabase("bigbud-manual-interaction-", async (dbPath) => {
      const first = createRuntime(dbPath);
      try {
        const engine = await engineFor(first);
        const commands: OrchestrationCommand[] = [
          ...createCommands(ProjectId.makeUnsafe("manual-project"), [threadId]),
          {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("manual-original"),
            threadId,
            message: { messageId, role: "user", text: "Continue", attachments: [] },
            ...options,
            createdAt,
          },
          {
            ...park,
            pendingInteractionGate: {
              ...gate,
              manualRecovery: "discard-and-resend",
              approvalRequests: [],
              userInputRequests: [],
            },
          },
          close("approval.resolved", approval),
          close("user-input.resolved", question),
        ];
        for (const command of commands) await first.runPromise(engine.dispatch(command));
      } finally {
        await first.dispose();
      }
      const second = createRuntime(dbPath);
      try {
        const engine = await engineFor(second);
        const read = async () =>
          (await second.runPromise(engine.getReadModel())).threads.find(
            (thread) => thread.id === threadId,
          );
        expect((await read())?.queuedPrompts).toMatchObject([
          {
            id: messageId,
            alreadySent: true,
            pendingInteractionGate: { manualRecovery: "discard-and-resend" },
          },
        ]);
        await expect(
          second.runPromise(engine.dispatch(release("unsafe-release"))),
        ).rejects.toMatchObject({ code: "queue_waiting_for_user" });
        await second.runPromise(
          engine.dispatch({
            type: "thread.queued-prompt.remove",
            threadId,
            messageId,
            commandId: CommandId.makeUnsafe("discard-held"),
            createdAt,
          }),
        );
        expect((await read())?.queuedPrompts).toEqual([]);
        expect((await read())?.messages.filter((message) => message.id === messageId)).toHaveLength(
          1,
        );
      } finally {
        await second.dispose();
      }
    }));

  it("survives terminal state and restart, then persists closure without releasing a user hold", () =>
    withDatabase("bigbud-interaction-fence-", async (dbPath) => {
      const first = createRuntime(dbPath);
      try {
        const engine = await engineFor(first);
        const commands: OrchestrationCommand[] = [
          ...createCommands(ProjectId.makeUnsafe("park-project"), [threadId]),
          {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("original-send"),
            threadId,
            message: { messageId, role: "user", text: "Continue", attachments: [] },
            ...options,
            createdAt,
          },
          {
            type: "thread.message.submit",
            commandId: CommandId.makeUnsafe("queue-suffix"),
            threadId,
            message: { messageId: suffixId, text: "Later" },
            delivery: "queue",
            createdAt,
          },
          park,
          stop(),
          {
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("old-session-stopped"),
            advanceSessionEpoch: true,
            threadId,
            session: {
              threadId,
              providerName: "claudeAgent",
              status: "stopped",
              activeTurnId: null,
              lastError: null,
              runtimeMode: "full-access",
              updatedAt: createdAt,
              sessionEpoch: 2,
            },
            createdAt,
          },
          {
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("replacement-session"),
            threadId,
            advanceSessionEpoch: true,
            session: {
              threadId,
              providerName: "claudeAgent",
              status: "ready",
              activeTurnId: null,
              runtimeMode: "full-access",
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          },
          close("approval.resolved", approval, 2),
        ];
        for (const command of commands) await first.runPromise(engine.dispatch(command));
        const fenced = (await first.runPromise(engine.getReadModel())).threads.find(
          (thread) => thread.id === threadId,
        );
        expect(fenced?.session).toMatchObject({ status: "ready", sessionEpoch: 2 });
        expect(fenced?.queuedPrompts).toMatchObject([
          { id: messageId, pendingInteractionGate: gate },
          { id: suffixId },
        ]);
        await first.runPromise(engine.dispatch(close("approval.resolved", approval)));
      } finally {
        await first.dispose();
      }
      const second = createRuntime(dbPath);
      try {
        const engine = await engineFor(second);
        const read = async () =>
          (await second.runPromise(engine.getReadModel())).threads.find(
            (thread) => thread.id === threadId,
          );
        expect((await read())?.queuedPrompts).toMatchObject([
          { id: messageId, pendingInteractionGate: { ...gate, approvalRequests: [] } },
          { id: suffixId },
        ]);
        await expect(second.runPromise(engine.dispatch(release("too-soon")))).rejects.toMatchObject(
          { code: "queue_waiting_for_user" },
        );
        await second.runPromise(engine.dispatch(close("user-input.resolved", question)));
        expect((await read())?.queuedPrompts?.[0]?.pendingInteractionGate).toBeUndefined();
        expect((await read())?.queueHold).toBe(true);
      } finally {
        await second.dispose();
      }
      const third = createRuntime(dbPath);
      try {
        const engine = await engineFor(third);
        const read = async () =>
          (await third.runPromise(engine.getReadModel())).threads.find(
            (thread) => thread.id === threadId,
          );
        expect((await read())?.queuedPrompts).toMatchObject([
          { id: messageId, alreadySent: true },
          { id: suffixId },
        ]);
        expect((await read())?.queuedPrompts?.[0]?.pendingInteractionGate).toBeUndefined();
        await third.runPromise(engine.dispatch(release("explicit-release")));
        expect((await read())?.queuedPrompts).toMatchObject([{ id: suffixId }]);
      } finally {
        await third.dispose();
      }
    }));
});
