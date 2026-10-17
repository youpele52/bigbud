import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetThreadTitleLockForTests,
  shouldAllowAutoTitleReplace,
} from "../orchestration-tools/ThreadTitleLock.ts";
import { TERMINAL_TITLE_COMMAND_PREFIX } from "../orchestration-tools/TerminalThreadTitle.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { createEmptyReadModel } from "./projectorReadModel.ts";

const threadId = ThreadId.makeUnsafe("thread-title");
const projectId = ProjectId.makeUnsafe("project-title");
const now = "2026-10-17T00:00:00.000Z";

/** Exercise the actual decision/projector boundary, retaining events for restart checks. */
async function fixture(title = "New thread") {
  let model = createEmptyReadModel(now);
  const events: OrchestrationEvent[] = [];
  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({ command, readModel: model });
      const next = Array.isArray(result) ? result : [result];
      for (const event of next) {
        const persisted = { ...event, sequence: events.length + 1 } as OrchestrationEvent;
        model = yield* projectEvent(model, persisted);
        events.push(persisted);
      }
      return { sequence: events.length };
    });
  await Effect.runPromise(
    dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("create-project"),
      projectId,
      title: "Project",
      workspaceRoot: "/fixture",
      createdAt: now,
    }),
  );
  await Effect.runPromise(
    dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("create-thread"),
      threadId,
      projectId,
      title,
      modelSelection: { provider: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    }),
  );
  const rename = (id: string, value: string) =>
    Effect.runPromise(
      dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(id),
        threadId,
        title: value,
      }),
    );
  const terminal = (value = "Fix terminal recovery") =>
    rename(`${TERMINAL_TITLE_COMMAND_PREFIX}${crypto.randomUUID()}`, value);
  const chat = () =>
    Effect.runPromise(
      dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe(`chat:${crypto.randomUUID()}`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          text: "Review authentication",
        },
        delivery: "queue",
        createdAt: now,
      }),
    );
  return { dispatch, rename, terminal, chat, events, thread: () => model.threads[0]! };
}

describe("serialized terminal title ownership", () => {
  afterEach(resetThreadTitleLockForTests);

  it.each(["New thread", "New chat"])(
    "names existing default %s threads and stops after first title",
    async (title) => {
      const harness = await fixture(title);
      await harness.terminal();
      await harness.terminal("Late terminal task");
      expect(harness.thread().title).toBe("Fix terminal recovery");
    },
  );

  it("protects terminal ownership against a later chat seed, generation and provider metadata", async () => {
    const harness = await fixture();
    await harness.terminal();
    await harness.chat();
    for (const id of [
      "server:thread-title-seed:1",
      "server:thread-title-rename:1",
      "provider:thread-meta-update:1",
    ]) {
      await harness.rename(id, "Late chat title");
    }
    expect(harness.thread().title).toBe("Fix terminal recovery");
    expect(
      shouldAllowAutoTitleReplace({
        threadId,
        currentTitle: harness.thread().title,
        titleSeed: harness.thread().title,
      }),
    ).toBe(false);
  });

  it("a submitted chat prompt wins even while the title is still default", async () => {
    const harness = await fixture();
    await harness.chat();
    await harness.terminal();
    expect(harness.thread().title).toBe("New thread");
    await harness.rename("server:thread-title-seed:1", "Review authentication");
    await harness.terminal();
    expect(harness.thread().title).toBe("Review authentication");
  });

  it("manual rename always wins, including resetting the title to default", async () => {
    const harness = await fixture();
    await harness.terminal();
    await harness.rename("user:manual", "New thread");
    await harness.terminal();
    await harness.rename("server:thread-title-rename:stale", "Stale generated title");
    expect(harness.thread().title).toBe("New thread");
  });

  it("leaves custom titles unchanged", async () => {
    const harness = await fixture("Existing custom title");
    await harness.terminal();
    expect(harness.thread().title).toBe("Existing custom title");
  });

  it("rehydrates terminal ownership from persisted metadata without a new state store", async () => {
    const harness = await fixture();
    await harness.terminal();
    resetThreadTitleLockForTests();
    await harness.rename("server:thread-title-rename:restart", "Late chat after restart");
    expect(harness.thread().title).toBe("Fix terminal recovery");
  });

  it("preserves chat ownership after a queued prompt is removed and locks are reset", async () => {
    const harness = await fixture();
    await harness.chat();
    const messageId = harness.thread().queuedPrompts![0]!.id;
    await Effect.runPromise(
      harness.dispatch({
        type: "thread.queued-prompt.remove",
        commandId: CommandId.makeUnsafe("remove-queue"),
        threadId,
        messageId,
        createdAt: now,
      }),
    );
    resetThreadTitleLockForTests();
    expect(harness.thread().queuedPrompts).toHaveLength(0);
    await harness.terminal();
    expect(harness.thread().title).toBe("New thread");
  });

  it("preserves a manual default title across restart without process-local locks", async () => {
    const harness = await fixture();
    await harness.rename("user:manual", "New thread");
    resetThreadTitleLockForTests();
    await harness.terminal();
    await harness.rename("server:thread-title-seed:restart", "A late chat title");
    expect(harness.thread().title).toBe("New thread");
  });

  it("never names archived threads", async () => {
    const harness = await fixture();
    await Effect.runPromise(
      harness.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId,
      }),
    );
    await harness.terminal();
    expect(harness.thread().title).toBe("New thread");
  });

  it("retains ownership when the ordinary activity window rolls over", async () => {
    const harness = await fixture();
    await harness.rename("user:manual", "New thread");
    for (let index = 0; index < 505; index++) {
      await Effect.runPromise(
        harness.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`activity:${index}`),
          threadId,
          activity: {
            id: EventId.makeUnsafe(`activity:${index}`),
            kind: "test.activity",
            tone: "info",
            summary: "Activity",
            payload: {},
            turnId: null,
            createdAt: `2026-10-17T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
          },
          createdAt: now,
        }),
      );
    }
    expect(harness.thread().activities).toHaveLength(500);
    resetThreadTitleLockForTests();
    await harness.terminal();
    expect(harness.thread().title).toBe("New thread");
  });

  it("keeps other metadata updates when suppressing a stale automatic title", async () => {
    const harness = await fixture();
    await harness.terminal();
    await Effect.runPromise(
      harness.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("provider:thread-meta-update:metadata"),
        threadId,
        title: "Stale name",
        branch: "new-branch",
      }),
    );
    expect(harness.thread().branch).toBe("new-branch");
    expect(harness.thread().title).toBe("Fix terminal recovery");
  });
});
