import { MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { afterEach, expect, it } from "vitest";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import {
  canonicalRenameThreadCommandId,
  renameThreadViaOrchestration,
} from "./ThreadOrchestrationTools.rename.ts";
import {
  isThreadTitleLocked,
  resetThreadTitleLockForTests,
  shouldAllowAutoTitleReplace,
} from "./ThreadTitleLock.ts";

afterEach(resetThreadTitleLockForTests);

it("reconciles exact rename receipts and relocks the target on replay after restart", async () => {
  await withDatabase("canonical-rename-restart-", async (path) => {
    const caller = ThreadId.makeUnsafe("restart-caller");
    const target = ThreadId.makeUnsafe("restart-target");
    const identity = {
      threadId: caller,
      sourceMessageId: MessageId.makeUnsafe("owned-source"),
      invocationId: "owned-call",
    };
    const args = {
      ...identity,
      targetThreadId: target,
      title: "ohno",
      threadDelegationRepository: {} as ThreadDelegationRepositoryShape,
    };
    const first = createRuntime(path);
    let sequence = 0;
    try {
      const engine = await engineFor(first);
      for (const command of createCommands(ProjectId.makeUnsafe("owned-project"), [
        caller,
        target,
      ])) {
        await first.runPromise(engine.dispatch(command));
      }
      const accepted = await first.runPromise(
        renameThreadViaOrchestration({ ...args, orchestrationEngine: engine }),
      );
      expect(accepted.commandId).toBe(canonicalRenameThreadCommandId(identity));
      sequence = (await first.runPromise(engine.getReadModel())).snapshotSequence;
    } finally {
      await first.dispose();
    }
    resetThreadTitleLockForTests();
    const restarted = createRuntime(path);
    try {
      const engine = await engineFor(restarted);
      const commandId = canonicalRenameThreadCommandId(identity);
      expect(await restarted.runPromise(engine.getCommandOutcome!(commandId))).toMatchObject({
        status: "accepted",
      });
      expect(await restarted.runPromise(engine.readEventsByCommandId!(commandId))).toEqual([
        expect.objectContaining({
          commandId,
          type: "thread.meta-updated",
          payload: expect.objectContaining({ threadId: target, title: "ohno" }),
        }),
        expect.objectContaining({
          commandId,
          type: "thread.activity-appended",
          payload: expect.objectContaining({
            threadId: target,
            activity: expect.objectContaining({
              kind: "thread.title-ownership",
              payload: { source: "manual" },
            }),
          }),
        }),
      ]);
      await restarted.runPromise(
        renameThreadViaOrchestration({ ...args, orchestrationEngine: engine }),
      );
      expect(isThreadTitleLocked(target)).toBe(true);
      expect(isThreadTitleLocked(caller)).toBe(false);
      expect(shouldAllowAutoTitleReplace({ threadId: target, currentTitle: "New thread" })).toBe(
        false,
      );
      expect((await restarted.runPromise(engine.getReadModel())).snapshotSequence).toBe(sequence);
      await expect(
        restarted.runPromise(
          renameThreadViaOrchestration({ ...args, title: "changed", orchestrationEngine: engine }),
        ),
      ).rejects.toThrow();
    } finally {
      await restarted.dispose();
    }
  });
});
