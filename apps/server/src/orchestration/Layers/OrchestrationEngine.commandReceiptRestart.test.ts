import { ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

describe("OrchestrationEngine command receipts", () => {
  it("retains an accepted receipt across restart and returns its stored sequence", () =>
    withDatabase("bigbud-command-receipt-restart-", async (dbPath) => {
      const command = createCommands(ProjectId.makeUnsafe("project-receipt-restart"), [])[0]!;
      const first = createRuntime(dbPath);
      const firstEngine = await engineFor(first);
      const accepted = await first.runPromise(firstEngine.dispatch(command));
      await first.dispose();

      const second = createRuntime(dbPath);
      const secondEngine = await engineFor(second);
      await expect(second.runPromise(secondEngine.dispatch(command))).resolves.toEqual(accepted);
      await expect(
        second.runPromise(secondEngine.getCommandOutcome!(command.commandId)),
      ).resolves.toMatchObject({
        status: "accepted",
        resultSequence: accepted.sequence,
      });
      await second.dispose();
    }));

  it("rejects same command id reuse with a changed payload after restart", () =>
    withDatabase("bigbud-command-receipt-conflict-", async (dbPath) => {
      const command = createCommands(ProjectId.makeUnsafe("project-receipt-conflict"), [])[0]!;
      if (command.type !== "project.create") throw new Error("expected project.create command");
      const first = createRuntime(dbPath);
      const firstEngine = await engineFor(first);
      const accepted = await first.runPromise(firstEngine.dispatch(command));
      await first.dispose();

      const second = createRuntime(dbPath);
      const secondEngine = await engineFor(second);
      await expect(second.runPromise(secondEngine.dispatch(command))).resolves.toEqual(accepted);
      await expect(
        second.runPromise(secondEngine.dispatch({ ...command, title: "Changed title" })),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandIdConflictError" });
      await expect(second.runPromise(secondEngine.readReplay(0))).resolves.toMatchObject({
        events: [expect.objectContaining({ sequence: accepted.sequence })],
      });
      await second.dispose();
    }));
});
