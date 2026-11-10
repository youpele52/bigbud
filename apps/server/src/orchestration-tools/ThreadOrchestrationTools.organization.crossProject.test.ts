import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";
import { expect, it } from "vitest";

import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import {
  makeTestCoordination,
  messageEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";
import type { ThreadCoordinationDeps } from "./ThreadCoordinationConfirmation.ts";
import {
  moveThreadViaOrchestration,
  snoozeThreadViaOrchestration,
} from "./ThreadOrchestrationTools.organization.ts";

const caller = ThreadId.makeUnsafe("organize-caller");
const target = ThreadId.makeUnsafe("organize-foreign-target");
const foreignProject = ProjectId.makeUnsafe("organize-foreign-project");
const notDelegated = {
  findDirectByChild: () => Effect.succeed(Option.none()),
} as unknown as ThreadDelegationRepositoryShape;

it("moves and snoozes a foreign thread only after confirmation, and replays after restart", async () => {
  await withDatabase("organize-cross-project-", async (path) => {
    const first = createRuntime(path);
    try {
      const engine = await engineFor(first);
      for (const command of [
        ...createCommands(ProjectId.makeUnsafe("organize-home"), [caller]),
        ...createCommands(foreignProject, [target]),
      ]) {
        await first.runPromise(engine.dispatch(command));
      }
      const organizationOf = async () =>
        (await first.runPromise(engine.getReadModel())).threads.find((t) => t.id === target)
          ?.organization;
      const move = (coordination: ThreadCoordinationDeps, invocationId: string) =>
        first.runPromise(
          moveThreadViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: notDelegated,
            coordination,
            threadId: caller,
            targetThreadId: target,
            state: "done",
            invocationId,
          }),
        );
      const { coordination, log } = makeTestCoordination();
      const before = await organizationOf();
      const challenge = await move(coordination, "move-1");
      if (!("status" in challenge) || challenge.status !== "confirmation_required") {
        throw new Error("expected a confirmation challenge");
      }
      expect(await organizationOf()).toEqual(before);

      log.push(
        messageEvent({
          threadId: caller,
          sequence: log.nextSequence(),
          text: `allow ${challenge.code}`,
        }),
      );
      expect(await move(coordination, "move-1")).toMatchObject({
        threadId: target,
        changed: true,
        organization: { state: "done" },
      });
      // The grant covers a different write to the same project, with no new prompt.
      await expect(
        first.runPromise(
          snoozeThreadViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: notDelegated,
            coordination,
            threadId: caller,
            targetThreadId: target,
            minutes: 30,
            invocationId: "snooze-1",
          }),
        ),
      ).resolves.toMatchObject({ changed: true, organization: { state: "later" } });
    } finally {
      await first.dispose();
    }

    const restarted = createRuntime(path);
    try {
      const engine = await engineFor(restarted);
      // Restart lost every grant: the committed move replays, a new one asks again.
      const { coordination } = makeTestCoordination();
      const move = (invocationId: string) =>
        restarted.runPromise(
          moveThreadViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: notDelegated,
            coordination,
            threadId: caller,
            targetThreadId: target,
            state: "done",
            invocationId,
          }),
        );
      expect(await move("move-1")).toMatchObject({
        changed: false,
        organization: { state: "done" },
      });
      expect(await move("move-2")).toMatchObject({ status: "confirmation_required" });
    } finally {
      await restarted.dispose();
    }
  });
});
