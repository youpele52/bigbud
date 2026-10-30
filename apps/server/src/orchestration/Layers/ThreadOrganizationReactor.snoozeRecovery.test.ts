import { CommandId, ProjectId, ThreadId, type OrchestrationCommand } from "@bigbud/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ThreadOrganizationReactor } from "../Services/ThreadOrganizationReactor.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";
import { ThreadOrganizationReactorLive } from "./ThreadOrganizationReactor.ts";

const projectId = ProjectId.makeUnsafe("itutu-snooze-recovery");
const threadId = ThreadId.makeUnsafe("thread-snooze-recovery");
const createdAt = "2026-10-30T00:00:00.000Z";

const expire = (id: string, snoozeId: string): OrchestrationCommand => ({
  type: "thread.organization.snooze.expire",
  commandId: CommandId.makeUnsafe(id),
  threadId,
  snoozeId,
  createdAt,
});

afterEach(() => vi.useRealTimers());

describe("Ìtútù snooze delivery", () => {
  it("delivers an overdue snooze once after downtime, and stale timers change nothing", () =>
    withDatabase("itutu-snooze-recovery-", async (dbPath) => {
      const first = createRuntime(dbPath);
      const firstEngine = await engineFor(first);
      for (const setup of createCommands(projectId, [threadId])) {
        await first.runPromise(firstEngine.dispatch(setup));
      }
      await first.runPromise(
        firstEngine.dispatch({
          type: "thread.organization.snooze",
          commandId: CommandId.makeUnsafe("snooze-1"),
          threadId,
          durationMinutes: 2,
          createdAt,
        }),
      );
      // Not due yet: the expire command is a no-op, never an error.
      await first.runPromise(firstEngine.dispatch(expire("early", "snooze-1")));
      expect(
        (await first.runPromise(firstEngine.getReadModel())).threads[0]?.organization,
      ).toMatchObject({ state: "later", snooze: { id: "snooze-1" } });
      await first.dispose();

      // The server was down past the deadline.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 3 * 60_000);

      const second = createRuntime(dbPath);
      const scope = await Effect.runPromise(Scope.make("sequential"));
      try {
        const engine = await engineFor(second);
        const pending = () =>
          second.runPromise(
            Effect.gen(function* () {
              return yield* (yield* ProjectionThreadRepository).listPendingSnoozes({ limit: 10 });
            }).pipe(Effect.provide(ProjectionThreadRepositoryLive)),
          );
        expect(await pending()).toMatchObject([{ threadId, snoozeId: "snooze-1" }]);

        await second.runPromise(
          Effect.gen(function* () {
            yield* (yield* ThreadOrganizationReactor).start();
          }).pipe(
            Effect.provide(
              ThreadOrganizationReactorLive.pipe(Layer.provide(ProjectionThreadRepositoryLive)),
            ),
            Scope.provide(scope),
          ),
        );
        const organization = async () =>
          (await second.runPromise(engine.getReadModel())).threads.find(
            (thread) => thread.id === threadId,
          )?.organization;
        await vi.waitFor(async () =>
          expect(await organization()).toMatchObject({
            state: "needs-you",
            revision: 2,
            snooze: null,
          }),
        );
        expect(await pending()).toEqual([]);

        // Duplicate and stale deliveries are no-ops.
        await second.runPromise(engine.dispatch(expire("duplicate", "snooze-1")));
        await second.runPromise(engine.dispatch(expire("stale", "snooze-0")));
        expect(await organization()).toMatchObject({ state: "needs-you", revision: 2 });
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await second.dispose();
      }
    }));
});
