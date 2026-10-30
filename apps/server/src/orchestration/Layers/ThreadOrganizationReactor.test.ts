import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { ThreadOrganizationReactor } from "../Services/ThreadOrganizationReactor.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";
import { ThreadOrganizationReactorLive } from "./ThreadOrganizationReactor.ts";

const threadId = ThreadId.makeUnsafe("thread-itutu-reactor");
const createdAt = "2026-10-30T00:00:00.000Z";

const approvalRequest = (id: string, requestId: string): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId: CommandId.makeUnsafe(`activity-${id}`),
  threadId,
  activity: {
    id: EventId.makeUnsafe(id),
    kind: "approval.requested",
    tone: "approval",
    summary: "Command approval requested",
    payload: { requestId, requestKind: "command" },
    turnId: null,
    createdAt,
  },
  createdAt,
});

const userMessage = (id: string): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe(`turn-${id}`),
  threadId,
  message: { messageId: MessageId.makeUnsafe(id), role: "user", text: "go", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt,
});

describe("ThreadOrganizationReactor", () => {
  it("moves blocked threads to Needs you once per request and back to Present on user work", () =>
    withDatabase("itutu-reactor-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      const scope = await Effect.runPromise(Scope.make("sequential"));
      try {
        const engine = await engineFor(runtime);
        const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
        for (const command of createCommands(ProjectId.makeUnsafe("itutu-reactor"), [threadId])) {
          await run(engine.dispatch(command));
        }
        await runtime.runPromise(
          Effect.gen(function* () {
            yield* (yield* ThreadOrganizationReactor).start();
          }).pipe(Effect.provide(ThreadOrganizationReactorLive), Scope.provide(scope)),
        );
        // Let the forked subscriber attach before the first event is published.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const organization = async () =>
          (await run(engine.getReadModel())).threads.find((thread) => thread.id === threadId)
            ?.organization;
        const waitForState = async (state: ThreadOrganizationState, revision: number) => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const current = await organization();
            if (current?.state === state && current.revision === revision) return current;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error(
            `timed out waiting for ${state}@${revision}: ${JSON.stringify(await organization())}`,
          );
        };

        await run(engine.dispatch(approvalRequest("approval-1", "request-1")));
        await waitForState("needs-you", 1);

        await run(engine.dispatch(userMessage("message-1")));
        await waitForState("present", 2);

        // An explicit Done survives a replayed request and provider-side activity.
        await run(
          engine.dispatch({
            type: "thread.organization.move",
            commandId: CommandId.makeUnsafe("move-done"),
            threadId,
            state: "done",
            createdAt,
          }),
        );
        await run(engine.dispatch(approvalRequest("approval-1-replay", "request-1")));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await organization()).toMatchObject({ state: "done", revision: 3 });

        // A new blocking request reaches the user again.
        await run(engine.dispatch(approvalRequest("approval-2", "request-2")));
        await waitForState("needs-you", 4);
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await runtime.dispose();
      }
    }));
});
