import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { makeEvent } from "../projector.test.helpers.ts";
import { makeThreadSessionsProjector } from "./ProjectionPipeline.projector.threadSessions.ts";

const now = "2026-08-18T00:00:00.000Z";

describe("thread sessions projector", () => {
  it("persists a starting session when a turn start is requested", async () => {
    let session: unknown = null;
    const projector = makeThreadSessionsProjector({
      projectionThreadRepository: {
        getById: () =>
          Effect.succeed(
            Option.some({
              modelSelection: { provider: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
            }),
          ),
      },
      projectionThreadSessionRepository: {
        getByThreadId: () => Effect.succeed(Option.none()),
        upsert: (next: unknown) => Effect.sync(() => void (session = next)),
      },
    } as never);

    await Effect.runPromise(
      projector.apply(
        makeEvent({
          sequence: 1,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-starting",
          occurredAt: now,
          commandId: "start",
          payload: {
            threadId: "thread-starting",
            messageId: "message-starting",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
        }),
        { prunedThreadRelativePaths: new Map() },
      ),
    );

    expect(session).toMatchObject({
      threadId: "thread-starting",
      status: "starting",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      sessionEpoch: 0,
      updatedAt: now,
    });
  });
});
