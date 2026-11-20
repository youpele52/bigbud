import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";

import { makeRuntimeMaintenanceGate } from "../../command-admission/RuntimeMaintenanceGate.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const createdAt = "2026-11-18T00:00:00.000Z";

it("runtime_on_trial_holds_queued_prompts_until_admission_reopens", () =>
  withDatabase("bigbud-maintenance-gate-", async (dbPath) => {
    const projectId = ProjectId.makeUnsafe("project-trial");
    const threadId = ThreadId.makeUnsafe("thread-trial");
    const first = createRuntime(dbPath);
    const firstEngine = await engineFor(first);
    for (const command of [
      ...createCommands(projectId, [threadId]),
      {
        type: "thread.message.submit" as const,
        commandId: CommandId.makeUnsafe("cmd-queue-trial"),
        threadId,
        message: { messageId: MessageId.makeUnsafe("message-trial"), text: "Continue" },
        delivery: "queue" as const,
        createdAt,
      },
    ])
      await first.runPromise(firstEngine.dispatch(command));
    await first.dispose();

    // A restarted runtime on trial (journal present) starts with admission closed.
    const gate = makeRuntimeMaintenanceGate({ initiallyClosed: true });
    const trial = createRuntime(dbPath, undefined, gate);
    const engine = await engineFor(trial);
    const thread = async () => (await trial.runPromise(engine.getReadModel())).threads[0];
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await thread())?.queuedPrompts).toHaveLength(1);
    expect((await thread())?.messages.some((message) => message.text === "Continue")).toBe(false);

    // Trial passed: reopening admission releases the held queue exactly as startup would.
    await trial.runPromise(gate.open);
    await vi.waitFor(async () => {
      expect((await thread())?.queuedPrompts).toEqual([]);
      expect((await thread())?.messages.some((message) => message.text === "Continue")).toBe(true);
    });
    await trial.dispose();
  }));
