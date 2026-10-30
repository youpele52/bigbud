import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const projectId = ProjectId.makeUnsafe("itutu-idle");
const quietThread = ThreadId.makeUnsafe("itutu-idle-quiet");
const busyThread = ThreadId.makeUnsafe("itutu-idle-busy");
const createdAt = "2026-10-30T00:00:00.000Z";

const idle = (id: string, threadId: ThreadId, expectedRevision: number) =>
  ({
    type: "thread.organization.idle",
    commandId: CommandId.makeUnsafe(id),
    threadId,
    expectedRevision,
    destination: "done",
    createdAt,
  }) as const;

describe("Ìtútù idle cleanup in the engine", () => {
  it("moves a quiet thread once and never a thread with admitted work", () =>
    withDatabase("itutu-idle-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        const run = <A, E>(effect: import("effect").Effect.Effect<A, E>) =>
          runtime.runPromise(effect);
        for (const command of createCommands(projectId, [quietThread, busyThread])) {
          await run(engine.dispatch(command));
        }
        // Work admitted before the idle move: the turn start is pending, so idle declines.
        await run(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("busy-turn"),
            threadId: busyThread,
            message: {
              messageId: MessageId.makeUnsafe("busy-message"),
              role: "user",
              text: "keep going",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await run(engine.dispatch(idle("idle-busy", busyThread, 0)));
        await run(engine.dispatch(idle("idle-stale", quietThread, 7)));
        await run(engine.dispatch(idle("idle-quiet", quietThread, 0)));
        await run(engine.dispatch(idle("idle-quiet-again", quietThread, 0)));

        const threads = (await run(engine.getReadModel())).threads;
        const organization = (threadId: ThreadId) =>
          threads.find((thread) => thread.id === threadId)?.organization;
        expect(organization(quietThread)).toMatchObject({ state: "done", revision: 1 });
        expect(organization(busyThread)).toMatchObject({ state: "present", revision: 0 });
      } finally {
        await runtime.dispose();
      }
    }));
});
