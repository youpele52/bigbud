import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import {
  reconcilePersistedCommands,
  subscribeToPersistedCommandChanges,
} from "./orchestrationCommandRecovery.reconcile";
import {
  readAttempt,
  savePendingCommand,
  setAttemptStatus,
} from "./orchestrationCommandRecovery.state";
import { ORCHESTRATION_COMMAND_LEDGER_KEY } from "./orchestrationCommandRecovery.storage";

function makeHarness() {
  const values = new Map<string, string>();
  const options = {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
    lockManager: null,
  };
  const command = {
    type: "thread.archive" as const,
    commandId: CommandId.makeUnsafe("recovery-idempotence"),
    threadId: ThreadId.makeUnsafe("recovery-thread"),
  };
  return { options, command, raw: () => values.get(ORCHESTRATION_COMMAND_LEDGER_KEY) };
}

describe("persisted command recovery idempotence", () => {
  it.each(["pending", "accepted-awaiting-event"] as const)(
    "does not write or notify twice for %s",
    async (status) => {
      const { options, command, raw } = makeHarness();
      await savePendingCommand(command, options);
      const sequence = status === "accepted-awaiting-event" ? 8 : null;
      await setAttemptStatus(command.commandId, status, options, sequence);
      const settled = raw();
      const revisions: number[] = [];
      const unsubscribe = subscribeToPersistedCommandChanges((revision) =>
        revisions.push(revision),
      );
      try {
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            setAttemptStatus(command.commandId, status, options, sequence),
          ),
        );
        expect(results).toEqual(Array(8).fill(true));
        expect(raw()).toBe(settled);
        expect(revisions).toEqual([]);
      } finally {
        unsubscribe();
      }
    },
  );

  it("still persists changes to dispatch time and accepted sequence", async () => {
    const { options, command, raw } = makeHarness();
    await savePendingCommand(command, options);
    const firstTime = "2026-10-08T11:00:00.000Z";
    const nextTime = "2026-10-08T11:01:00.000Z";
    await setAttemptStatus(command.commandId, "dispatching", options, null, firstTime);
    const first = raw();
    await setAttemptStatus(command.commandId, "dispatching", options, null, nextTime);
    expect(raw()).not.toBe(first);
    expect(readAttempt(command.commandId, options)?.dispatchStartedAt).toBe(nextTime);
    await setAttemptStatus(command.commandId, "accepted-awaiting-event", options, 8);
    const accepted = raw();
    await setAttemptStatus(command.commandId, "accepted-awaiting-event", options, 9);
    expect(raw()).not.toBe(accepted);
    expect(readAttempt(command.commandId, options)?.acceptedSequence).toBe(9);
  });

  it.each(["unknown", "unavailable"])(
    "keeps %s recovery evidence without generating repeated ledger notifications",
    async (outcome) => {
      const { options, command, raw } = makeHarness();
      await savePendingCommand(command, options);
      const api = {
        orchestration: {
          getCommandOutcome: async () => {
            if (outcome === "unavailable") throw new Error("transport unavailable");
            return { status: "unknown" };
          },
        },
      } as unknown as Parameters<typeof reconcilePersistedCommands>[0];
      await reconcilePersistedCommands(api, options);
      const settled = raw();
      for (let index = 0; index < 3; index++) {
        expect(await reconcilePersistedCommands(api, options)).toMatchObject({
          pending: 1,
          retried: 0,
        });
      }
      expect(raw()).toBe(settled);
      expect(readAttempt(command.commandId, options)?.status).toBe("pending");
    },
  );
});
