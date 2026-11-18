import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { DirectResourceCleanupExecutorError } from "../../deletion/Services/DirectResourceCleanupExecutor.ts";

const UNSUPPORTED_DETAIL = "Resource cleanup is unsupported on linux/ia32.";

vi.mock("../../deletion/Layers/DirectResourceCleanupExecutor.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../deletion/Layers/DirectResourceCleanupExecutor.ts")
  >()),
  makeDirectResourceCleanupExecutor: () => ({
    prepare: () =>
      Effect.fail(
        new DirectResourceCleanupExecutorError({
          detail: UNSUPPORTED_DETAIL,
          cause: new Error(UNSUPPORTED_DETAIL),
        }),
      ),
  }),
}));

import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor cleanup executor preparation failures", () => {
  registerProviderCommandReactorTestCleanup();

  it("records the executor's reason, without stack frames, when Delete Now cannot prepare cleanup", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("delete-with-unprepared-cleanup"),
        threadId,
      }),
    );

    await waitFor(async () => {
      const model = await Effect.runPromise(harness.engine.getReadModel());
      const thread = model.threads.find((entry) => entry.id === threadId);
      return (
        thread?.deletingAt === null &&
        thread.activities.some((activity) => activity.kind === "thread.delete.failed")
      );
    });

    const model = await Effect.runPromise(harness.engine.getReadModel());
    const thread = model.threads.find((entry) => entry.id === threadId);
    expect(thread?.deletedAt).toBeNull();
    const failure = thread?.activities.find((activity) => activity.kind === "thread.delete.failed");
    const detail = (failure?.payload as { readonly detail?: unknown } | undefined)?.detail;
    expect(typeof detail).toBe("string");
    expect(detail).toContain(UNSUPPORTED_DETAIL);
    expect(detail).not.toMatch(/\n\s+at /);
  });
});
