import {
  CommandId,
  MessageId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  childId,
  expireCommand,
  fallback,
  heldMessageId,
  holdCommand,
} from "../deciderThreads.delegationModelChoice.test.helpers.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const userQueued: OrchestrationCommand = {
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("cmd-user-queued"),
  threadId: childId,
  message: { messageId: MessageId.makeUnsafe("user-follow-up"), text: "User follow-up" },
  delivery: "queue",
  createdAt: "2026-10-15T10:00:02.000Z",
};

describe("delegated model choice across a server restart (H1)", () => {
  it("keeps the held first turn queued at startup; the sweep then sends it once", () =>
    withDatabase("bigbud-model-choice-restart-", async (dbPath) => {
      const first = createRuntime(dbPath);
      const firstEngine = await engineFor(first);
      for (const command of [
        ...createCommands(ProjectId.makeUnsafe("project-hold"), [childId]),
        holdCommand(),
        userQueued,
      ]) {
        await first.runPromise(firstEngine.dispatch(command));
      }
      await first.dispose();

      const second = createRuntime(dbPath);
      const engine = await engineFor(second);
      // Commands run in order, so startup recovery has run before the sweep's expire.
      const sweepExpire = expireCommand();
      if (sweepExpire.type !== "thread.delegation.model-choice.expire") throw new Error("expire");
      await second.runPromise(
        engine.dispatch({
          ...sweepExpire,
          resolvedBy: "restart-sweep",
          commandId: CommandId.makeUnsafe("model-choice-sweep:restart"),
        }),
      );
      const events = await second.runPromise(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk) as OrchestrationEvent[]),
        ),
      );
      const sent = events.filter(
        (event) =>
          event.type === "thread.message-sent" && event.payload.text.includes("Delegated task"),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.payload).toMatchObject({ messageId: heldMessageId });
      const resolved = events.find(
        (event) =>
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "delegation.model-choice-resolved",
      );
      expect(
        resolved?.type === "thread.activity-appended" && resolved.payload.activity.payload,
      ).toMatchObject({
        used: fallback,
        resolvedBy: "restart-sweep",
      });
      expect(
        resolved?.type === "thread.activity-appended" &&
          (resolved.payload.activity.payload as { cancelled?: boolean }).cancelled,
      ).not.toBe(true);
      await second.dispose();
    }));
});
