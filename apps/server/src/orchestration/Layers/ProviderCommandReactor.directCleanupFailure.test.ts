import fs from "node:fs";

import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const executor = vi.hoisted(() => ({
  close: vi.fn(),
  execute: vi.fn(async () => Promise.reject(new Error("stdin EPIPE after acceptance"))),
}));

vi.mock("../../deletion/Layers/DirectResourceCleanupExecutor.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../deletion/Layers/DirectResourceCleanupExecutor.ts")
  >()),
  makeDirectResourceCleanupExecutor: () => ({
    prepare: () =>
      Effect.succeed({
        assertAlive: async () => undefined,
        execute: executor.execute,
        close: executor.close,
      }),
  }),
}));

import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor direct cleanup failures", () => {
  registerProviderCommandReactorTestCleanup();

  it("defers a committed Delete Now cleanup after an executor pipe failure and processes another command", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const providerLogDirectory = `${harness.stateDir}/logs/provider`;
    fs.mkdirSync(providerLogDirectory, { recursive: true });
    fs.writeFileSync(`${providerLogDirectory}/${threadId}.log`, "delete me");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("delete-with-pipe-failure"),
        threadId,
      }),
    );

    await waitFor(async () => {
      const rows = await Effect.runPromise(
        harness.sql<{ readonly state: string; readonly errorCode: string }>`
          SELECT state, last_error_code AS "errorCode" FROM direct_resource_cleanup_plans
        `,
      );
      return rows[0]?.state === "retry" && rows[0]?.errorCode === "process_failure";
    });

    const [plan, attempt] = await Effect.runPromise(
      Effect.all([
        harness.sql<{ readonly state: string; readonly errorCode: string }>`
          SELECT state, last_error_code AS "errorCode" FROM direct_resource_cleanup_plans
        `,
        harness.sql<{ readonly state: string }>`
          SELECT state FROM direct_resource_cleanup_attempts
        `,
      ]),
    );
    expect(plan).toEqual([{ state: "retry", errorCode: "process_failure" }]);
    expect(attempt).toEqual([{ state: "ambiguous" }]);
    expect(executor.close).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);

    const afterFailure = await Effect.runPromise(harness.engine.getReadModel());
    expect(afterFailure.threads.find((thread) => thread.id === threadId)).toBeUndefined();

    const nextThreadId = ThreadId.makeUnsafe("thread-after-pipe-failure");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("create-after-pipe-failure"),
        threadId: nextThreadId,
        projectId: afterFailure.projects[0]!.id,
        title: "Still responsive",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("delete-after-pipe-failure"),
        threadId: nextThreadId,
      }),
    );
    await waitFor(() => executor.close.mock.calls.length === 2);
    expect(executor.close).toHaveBeenCalledTimes(2);
    const finalModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(finalModel.threads.find((thread) => thread.id === nextThreadId)).toBeUndefined();
  });
});
