import { CommandId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const TERMINAL_REASON = "Unresolved direct shell ownership prevents bulk cleanup.";

describe("ProviderCommandReactor deletion failure reasons", () => {
  registerProviderCommandReactorTestCleanup();

  it("says which runtime cleanup blocked a deletion, on the activity and the restore event", async () => {
    const harness = await createHarness({ terminalCloseFailure: TERMINAL_REASON });
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("delete-blocked-by-terminal"),
        threadId,
      }),
    );

    let failed: Extract<OrchestrationEvent, { type: "thread.deletion-failed" }> | undefined;
    await waitFor(async () => {
      const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
      failed = Array.from(events).find(
        (event): event is NonNullable<typeof failed> => event.type === "thread.deletion-failed",
      );
      return failed !== undefined;
    });

    const expected = `Terminal cleanup failed: ${TERMINAL_REASON}`;
    expect(failed?.payload.reason).toBe(expected);
    await waitFor(async () => {
      const model = await Effect.runPromise(harness.engine.getReadModel());
      const thread = model.threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some((activity) => activity.kind === "thread.delete.failed") === true
      );
    });
    const model = await Effect.runPromise(harness.engine.getReadModel());
    const thread = model.threads.find((entry) => entry.id === threadId);
    expect(thread?.deletedAt).toBeNull();
    expect(thread?.deletingAt).toBeNull();
    const activity = thread?.activities.find((entry) => entry.kind === "thread.delete.failed");
    expect((activity?.payload as { readonly detail?: unknown } | undefined)?.detail).toBe(expected);
  });
});
