import { MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";
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
import {
  makeTestCoordination,
  messageEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

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
      expect(accepted).toMatchObject({ commandId: canonicalRenameThreadCommandId(identity) });
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

it("replays a committed cross-project rename after restart without a new confirmation", async () => {
  await withDatabase("canonical-rename-foreign-restart-", async (path) => {
    const caller = ThreadId.makeUnsafe("foreign-restart-caller");
    const target = ThreadId.makeUnsafe("foreign-restart-target");
    const foreignProject = ProjectId.makeUnsafe("foreign-restart-project");
    const identity = {
      threadId: caller,
      sourceMessageId: MessageId.makeUnsafe("foreign-source"),
      invocationId: "foreign-call",
    };
    const args = {
      ...identity,
      targetThreadId: target,
      title: "renamed abroad",
      threadDelegationRepository: {
        findDirectByChild: () => Effect.succeed(Option.none()),
      } as unknown as ThreadDelegationRepositoryShape,
    };
    const first = createRuntime(path);
    try {
      const engine = await engineFor(first);
      for (const command of [
        ...createCommands(ProjectId.makeUnsafe("home-project"), [caller]),
        ...createCommands(foreignProject, [target]),
      ]) {
        await first.runPromise(engine.dispatch(command));
      }
      const granted = makeTestCoordination();
      await Effect.runPromise(granted.grants.grant(caller, foreignProject));
      await expect(
        first.runPromise(
          renameThreadViaOrchestration({
            ...args,
            orchestrationEngine: engine,
            coordination: granted.coordination,
          }),
        ),
      ).resolves.toMatchObject({ commandId: canonicalRenameThreadCommandId(identity) });
    } finally {
      await first.dispose();
    }
    resetThreadTitleLockForTests();
    const restarted = createRuntime(path);
    try {
      const engine = await engineFor(restarted);
      // The restart lost every grant.
      const { coordination, grants, log } = makeTestCoordination();
      const pendingChallenge = () =>
        Effect.runPromise(grants.getChallenge(caller, foreignProject)).then(Option.isSome);
      const run = (overrides: Partial<typeof args> & { invocationId?: string } = {}) =>
        restarted.runPromise(
          renameThreadViaOrchestration({
            ...args,
            ...overrides,
            orchestrationEngine: engine,
            coordination,
          }),
        );
      await expect(run()).resolves.toMatchObject({
        title: "renamed abroad",
        threadId: target,
        commandId: canonicalRenameThreadCommandId(identity),
      });
      expect(isThreadTitleLocked(target)).toBe(true);
      // A pure replay never issues a challenge.
      expect(await pendingChallenge()).toBe(false);
      await expect(run({ title: "changed abroad" })).resolves.toMatchObject({
        status: "confirmation_required",
      });
      expect(await pendingChallenge()).toBe(true);
      // ...nor consumes a pending denial meant for the new rename.
      log.push(messageEvent({ threadId: caller, sequence: log.nextSequence(), text: "no" }));
      await expect(run()).resolves.toMatchObject({ title: "renamed abroad", threadId: target });
      expect(await pendingChallenge()).toBe(true);
      await expect(run({ title: "changed abroad" })).resolves.toMatchObject({
        status: "confirmation_denied",
      });
      await expect(run({ invocationId: "fresh-call" })).resolves.toMatchObject({
        status: "confirmation_required",
      });
    } finally {
      await restarted.dispose();
    }
  });
});
