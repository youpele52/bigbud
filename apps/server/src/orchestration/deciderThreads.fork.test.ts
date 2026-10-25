import { MessageId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  activity,
  apply,
  decide,
  forkCommand,
  IMAGE,
  message,
  readModel,
  SOURCE,
  sourceThread,
} from "./deciderThreads.fork.test.helpers.ts";

const forkOf = async (model: Parameters<typeof decide>[0], command = forkCommand({})) => {
  const events = await decide(model, command);
  const next = await apply(model, events);
  return { events, fork: next.threads.find((thread) => thread.id === command.threadId), next };
};

describe("thread.fork decider", () => {
  it("copies provider subagent display fields with stale activity", async () => {
    const source = sourceThread({ pairs: 2, tasks: 1 });
    const agent = {
      ...source.tasks![0]!,
      id: "agent-1",
      kind: "providerSubagent",
      activityFresh: true,
      status: "inProgress",
      model: "claude-sonnet-4-5",
      effort: "high",
      prompt: "Review the diff",
      depth: 1,
      resultSummary: "Partial review",
      metrics: { totalTokens: 900, toolUses: 2 },
      recentSteps: [{ id: "tool-1", toolName: "Read", status: "completed", at: source.createdAt }],
    };
    const { fork } = await forkOf(readModel({ ...source, tasks: [agent] as never }));

    expect(fork?.tasks?.[0]).toMatchObject({
      kind: "providerSubagent",
      activityFresh: false,
      model: "claude-sonnet-4-5",
      effort: "high",
      prompt: "Review the diff",
      depth: 1,
      resultSummary: "Partial review",
      metrics: { totalTokens: 900, toolUses: 2 },
      recentSteps: [{ id: "tool-1", toolName: "Read", status: "completed" }],
    });
  });

  it("copies bounded history, plans, tasks and activities with lineage", async () => {
    const source = sourceThread({
      pairs: 130,
      plans: 60,
      tasks: 3,
      activities: [
        ...Array.from({ length: 520 }, (_, index) =>
          activity(`tool-${index}`, "tool.completed", index),
        ),
        activity("failed-1", "provider.turn.start.failed", 600, { failureClass: "session-dead" }),
        activity("recovery-1", "provider.session.recovery", 601, { step: "revive" }),
      ],
    });
    const { fork, next } = await forkOf(readModel(source));

    expect(fork?.messages).toHaveLength(200);
    expect(fork?.messages.at(-1)?.text).toBe("assistant assistant-129");
    expect(fork?.messages.every((entry) => !source.messages.some((s) => s.id === entry.id))).toBe(
      true,
    );
    expect(fork?.parentThread).toEqual({
      threadId: SOURCE,
      title: source.title,
      projectId: source.projectId,
    });
    expect(fork?.forkOrigin).toMatchObject({
      reason: "manual",
      forkPointMessageId: MessageId.makeUnsafe("assistant-129"),
      failureEventId: null,
    });
    expect(fork?.modelSelection).toEqual(source.modelSelection);
    expect(fork?.branch).toBe("feature/x");
    expect(fork?.proposedPlans).toHaveLength(50);
    const copied = fork?.activities.filter((entry) => entry.kind === "tool.completed") ?? [];
    expect(copied).toHaveLength(499); // newest 500 slots minus the fork-origin activity
    expect(fork?.activities.some((entry) => entry.kind === "provider.turn.start.failed")).toBe(
      false,
    );
    expect(fork?.activities.some((entry) => entry.kind === "provider.session.recovery")).toBe(
      false,
    );
    expect(
      fork?.activities.find((entry) => entry.kind === "thread.fork-origin")?.payload,
    ).toMatchObject({
      sourceThreadId: SOURCE,
      sourceTitle: source.title,
    });
    expect(fork?.tasks).toHaveLength(3);
    const taskIds = new Set(fork?.tasks?.map((task) => task.id));
    expect(fork?.tasks?.every((task) => !task.parentTaskId || taskIds.has(task.parentTaskId))).toBe(
      true,
    );
    const sourceAfter = next.threads.find((thread) => thread.id === SOURCE);
    expect(sourceAfter?.activities.at(-1)).toMatchObject({
      kind: "thread.forked",
      payload: { forkThreadId: "fork-thread", reason: "manual" },
    });
  });

  it("excludes streaming and uncertain trailing-turn messages from the copy", async () => {
    const source = sourceThread({
      pairs: 2,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-uncertain"),
        state: "error",
        requestedAt: "2026-10-15T09:59:00.000Z",
        startedAt: "2026-10-15T09:59:00.000Z",
        completedAt: "2026-10-15T09:59:01.000Z",
        assistantMessageId: null,
      } as never,
      extraMessages: [
        message("user-uncertain", "user", 100),
        message("assistant-uncertain", "assistant", 101, {
          turnId: TurnId.makeUnsafe("turn-uncertain"),
        }),
        message("assistant-streaming", "assistant", 102, { streaming: true }),
      ],
    });
    const { fork } = await forkOf(readModel(source));
    const texts = fork?.messages.map((entry) => entry.text) ?? [];
    expect(texts).toHaveLength(4);
    expect(texts.join("\n")).not.toContain("uncertain");
    expect(texts.join("\n")).not.toContain("streaming");
    expect(fork?.forkOrigin?.forkPointMessageId).toBe(MessageId.makeUnsafe("assistant-1"));
  });

  it("is idempotent per fork thread id, per failure and per pending message", async () => {
    const source = sourceThread({ pairs: 1 });
    const first = await forkOf(readModel(source), forkCommand({ failureEventId: "failure-1" }));
    expect(await decide(first.next, forkCommand({ commandId: "cmd-retry" }))).toEqual([]);
    expect(
      await decide(
        first.next,
        forkCommand({ threadId: "other-fork", commandId: "cmd-2", failureEventId: "failure-1" }),
      ),
    ).toEqual([]);
    const withPending = sourceThread({
      pairs: 1,
      extraMessages: [message("user-pending", "user", 50)],
    });
    const pendingFork = await forkOf(
      readModel(withPending),
      forkCommand({ pendingMessageId: "user-pending" }),
    );
    expect(
      await decide(
        pendingFork.next,
        forkCommand({ threadId: "fork-b", commandId: "cmd-b", pendingMessageId: "user-pending" }),
      ),
    ).toEqual([]);
  });

  it("never switches provider automatically; only an explicit manual choice may", async () => {
    await expect(
      decide(
        readModel(sourceThread({ pairs: 1 })),
        forkCommand({
          reason: "recovery-failed",
          modelSelection: { provider: "claudeAgent", model: "sonnet" },
        }),
      ),
    ).rejects.toThrow(/provider/i);
    const chosen = await forkOf(
      readModel(sourceThread({ pairs: 1 })),
      forkCommand({ modelSelection: { provider: "claudeAgent", model: "sonnet" } }),
    );
    expect(chosen.fork?.modelSelection).toEqual({ provider: "claudeAgent", model: "sonnet" });
    const sameProvider = await forkOf(
      readModel(sourceThread({ pairs: 1 })),
      forkCommand({ modelSelection: { provider: "codex", model: "model-b" } }),
    );
    expect(sameProvider.fork?.modelSelection).toEqual({ provider: "codex", model: "model-b" });
  });

  it("sends a never-admitted pending message with its attachments in the fork", async () => {
    const pending = message("user-pending", "user", 50, { attachments: [IMAGE] });
    const source = sourceThread({
      pairs: 1,
      extraMessages: [pending],
      activities: [
        activity("turn-start-failed:evt-1", "provider.turn.start.failed", 60, {
          detail: "Provider session closed.",
          failureClass: "session-dead",
        }),
      ],
    });
    const { events, fork } = await forkOf(
      readModel(source),
      forkCommand({ pendingMessageId: "user-pending", failureEventId: "turn-start-failed:evt-1" }),
    );
    const requested = events.find((event) => event.type === "thread.turn-start-requested");
    expect(requested?.aggregateId).toBe("fork-thread");
    const sent = fork?.messages.at(-1);
    expect(sent).toMatchObject({ role: "user", text: pending.text, attachments: [IMAGE] });
    expect(sent?.id).not.toBe(pending.id);
    expect(fork?.forkOrigin?.pendingDelivery).toBe("sent");
    expect(fork?.queuedPrompts).toEqual([]);
  });

  it("holds an uncertain pending message as a draft prompt and never replays it (OpenCode V2)", async () => {
    const pending = message("user-pending", "user", 50, { attachments: [IMAGE] });
    const source = sourceThread({
      pairs: 2,
      provider: "opencodeV2",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-uncertain"),
        state: "error",
        requestedAt: "2026-10-15T09:59:00.000Z",
        startedAt: "2026-10-15T09:59:00.000Z",
        completedAt: "2026-10-15T09:59:01.000Z",
        assistantMessageId: null,
      } as never,
      extraMessages: [
        message("assistant-uncertain", "assistant", 40, {
          turnId: TurnId.makeUnsafe("turn-uncertain"),
        }),
        pending,
      ],
      activities: [
        activity("turn-start-failed:evt-2", "provider.turn.start.failed", 60, {
          detail: "V2 OpenCode is still running a turn; nothing was replayed.",
          failureClass: "unsafe-to-replay",
        }),
      ],
    });
    const { events, fork } = await forkOf(
      readModel(source),
      forkCommand({ pendingMessageId: "user-pending", failureEventId: "turn-start-failed:evt-2" }),
    );
    expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(false);
    expect(fork?.messages.map((entry) => entry.text).join("\n")).not.toContain("uncertain");
    expect(fork?.messages.some((entry) => entry.text === pending.text)).toBe(false);
    expect(fork?.queueHold).toBe(true);
    expect(fork?.queuedPrompts).toEqual([
      expect.objectContaining({ text: pending.text, attachments: [IMAGE] }),
    ]);
    expect(fork?.forkOrigin?.pendingDelivery).toBe("held");
  });
});
