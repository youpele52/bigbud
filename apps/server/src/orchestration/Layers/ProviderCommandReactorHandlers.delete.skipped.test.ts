import { CommandId, type OrchestrationCommand, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  reportSkippedActiveThreadDeletion,
  THREAD_DELETE_SKIPPED_ACTIVITY_KIND,
} from "./ProviderCommandReactorHandlers.delete.skipped.ts";
import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");

const captureLogs = (messages: Array<string>) =>
  Logger.layer(
    [
      Logger.make(({ message }) => {
        messages.push(JSON.stringify(message));
      }),
    ],
    { mergeWithExisting: false },
  );

describe("skipped_active thread deletion", () => {
  registerProviderCommandReactorTestCleanup();

  it("records why a delete of a running thread was undone", async () => {
    const harness = await createHarness();
    await Effect.runPromise(
      harness.startSession(threadId, {
        threadId,
        provider: "codex",
        runtimeMode: "approval-required",
      }),
    );
    // The provider now reports the thread's session as running a turn.
    await Effect.runPromise(harness.sendTurn({}));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-delete-active"),
        threadId,
      }),
    );
    const readThread = async () =>
      (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      );
    await waitFor(async () => {
      const thread = await readThread();
      return (
        thread?.deletingAt === null &&
        thread.activities.some((activity) => activity.kind === THREAD_DELETE_SKIPPED_ACTIVITY_KIND)
      );
    }, 5_000);

    const thread = await readThread();
    expect(thread?.deletedAt).toBeNull();
    expect(harness.stopSession).not.toHaveBeenCalled();
    const skipped = thread?.activities.find(
      (activity) => activity.kind === THREAD_DELETE_SKIPPED_ACTIVITY_KIND,
    );
    expect(skipped?.tone).toBe("info");
    expect(skipped?.payload).toEqual({ reason: "active-runtime", threadIds: [threadId] });
    expect(thread?.activities.some((activity) => activity.kind === "thread.delete.failed")).toBe(
      false,
    );
  });

  it("logs a structured warning and survives a failed activity append", async () => {
    const messages: Array<string> = [];
    const dispatched: Array<OrchestrationCommand> = [];
    const engine = {
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return Effect.fail(new Error("append rejected"));
      },
    } as unknown as OrchestrationEngineShape;

    await Effect.runPromise(
      reportSkippedActiveThreadDeletion(engine, {
        rootThreadId: threadId,
        threadIds: [threadId],
        reason: "subtree-changed",
        mode: "subtree",
        origin: "project-cascade",
        deletionEventId: "event-delete-requested",
        createdAt: new Date().toISOString(),
      }).pipe(Effect.provide(Layer.mergeAll(captureLogs(messages)))),
    );

    const aborted = messages.find((message) =>
      message.includes("thread deletion aborted: thread became active"),
    );
    expect(aborted).toBeDefined();
    for (const field of [
      '"outcome":"skipped_active"',
      '"reason":"subtree-changed"',
      '"rootThreadId":"thread-1"',
      '"origin":"project-cascade"',
      '"deletionEventId":"event-delete-requested"',
    ]) {
      expect(aborted).toContain(field);
    }
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      threadId,
      activity: {
        kind: THREAD_DELETE_SKIPPED_ACTIVITY_KIND,
        payload: { reason: "subtree-changed" },
      },
    });
    expect(
      messages.some((message) =>
        message.includes("could not record a skipped thread deletion activity"),
      ),
    ).toBe(true);
  });
});
