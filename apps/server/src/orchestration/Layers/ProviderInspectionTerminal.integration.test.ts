import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  registerCheckpointReactorTestCleanup,
  gitRefExists,
} from "./CheckpointReactor.test.helpers.ts";
import {
  createInspectionTerminalHarness,
  inspectionThreadId,
  inspectionTurnId,
  waitInspectionDelivery,
} from "./ProviderInspectionTerminal.integration.helpers.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";

describe("supervisor inspected terminal through normal durable delivery", () => {
  registerCheckpointReactorTestCleanup();

  it.each(["text", "empty", "failed", "plan"] as const)(
    "finalizes %s output, checkpoints, and recovery without a diff notification",
    async (mode) => {
      const h = await createInspectionTerminalHarness(mode);
      const dispatch = h.engine.dispatch;
      const readiness = vi.spyOn(h.engine, "dispatch").mockImplementation((command) => {
        if (
          command.type === "thread.session.set" &&
          String(command.commandId).includes(":terminal:")
        )
          expect(gitRefExists(h.cwd, checkpointRefForThreadTurn(inspectionThreadId, 1))).toBe(true);
        return dispatch(command);
      });
      try {
        await h.inspect();
        await waitInspectionDelivery(h);
        const thread = (await Effect.runPromise(h.engine.getReadModel())).threads[0]!;
        expect(thread.session?.activeTurnId).toBeNull();
        expect(thread.session?.status).toBe(mode === "failed" ? "error" : "ready");
        expect(thread.latestTurn).toMatchObject({
          turnId: inspectionTurnId,
          state: mode === "failed" ? "error" : "completed",
          completedAt: h.completedAt,
        });
        expect(thread.checkpoints).toHaveLength(1);
        expect(thread.checkpoints[0]).toMatchObject({
          turnId: inspectionTurnId,
          checkpointTurnCount: 1,
          status: mode === "failed" ? "error" : "ready",
        });
        expect(gitRefExists(h.cwd, checkpointRefForThreadTurn(inspectionThreadId, 1))).toBe(true);
        if (mode === "text")
          expect(
            thread.messages
              .filter((message) => message.id === "assistant:lost-message")
              .map((message) => message.text),
          ).toEqual(["durable text"]);
        if (mode === "empty" || mode === "failed") expect(thread.messages).toHaveLength(0);
        if (mode === "plan")
          expect(thread.proposedPlans.map((plan) => plan.planMarkdown)).toEqual([
            "## Durable plan\n- ship once",
          ]);
        if (mode === "failed") {
          for (let i = 0; i < 4; i++) {
            h.advance(10_001);
            await h.runPass();
          }
        }
        expect((await h.intent()).disposition).toBe("settled");
        await h.runPass();
        expect(
          (await Effect.runPromise(h.engine.getReadModel())).threads[0]?.checkpoints,
        ).toHaveLength(1);
        expect(h.nativeWork).not.toHaveBeenCalled();
      } finally {
        readiness.mockRestore();
        await h.close();
      }
    },
  );

  it.each(["empty", "plan"] as const)(
    "replays %s after a durable terminal claim and DB/layer restart without native inspection",
    async (mode) => {
      const h = await createInspectionTerminalHarness(mode, "publication");
      try {
        await h.inspect();
        expect(await h.active()).toHaveLength(0);
        expect(await h.pending()).toHaveLength(1);
        await h.restartDelivery();
        await waitInspectionDelivery(h);
        const thread = (await Effect.runPromise(h.engine.getReadModel())).threads[0]!;
        expect(thread.latestTurn).toMatchObject({ turnId: inspectionTurnId, state: "completed" });
        expect(thread.checkpoints).toHaveLength(1);
        if (mode === "plan")
          expect(thread.proposedPlans.map((plan) => plan.planMarkdown)).toEqual([
            "## Durable plan\n- ship once",
          ]);
        expect((await h.intent()).disposition).toBe("settled");
        expect(h.nativeWork).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    },
  );

  it("retains claimed-but-canonical-unpublished output across restart and settles normally exactly once", async () => {
    const h = await createInspectionTerminalHarness("text");
    let fail = true;
    let failures = 0;
    const dispatch = h.engine.dispatch;
    const spy = vi.spyOn(h.engine, "dispatch").mockImplementation((command) => {
      if (
        fail &&
        command.type === "thread.session.set" &&
        String(command.commandId).includes(":terminal:")
      ) {
        failures++;
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "injected canonical publication failure",
          }),
        );
      }
      return dispatch(command);
    });
    try {
      await h.inspect();
      await h.ingestionDrain();
      await h.drain();
      await h.runPass();
      await h.ingestionDrain();
      expect(await h.active()).toHaveLength(0);
      expect(await h.pending()).toHaveLength(1);
      expect(failures).toBeGreaterThan(0);
      fail = false;
      await h.restartDelivery();
      await waitInspectionDelivery(h);
      await h.runPass();
      const thread = (await Effect.runPromise(h.engine.getReadModel())).threads[0]!;
      expect(thread.session?.activeTurnId).toBeNull();
      expect(
        thread.messages
          .filter((message) => message.id === "assistant:lost-message")
          .map((message) => message.text),
      ).toEqual(["durable text"]);
      expect(thread.checkpoints).toHaveLength(1);
      expect((await h.intent()).disposition).toBe("settled");
      const events = await Effect.runPromise(Stream.runCollect(h.engine.readEvents(0)));
      const terminalSessions = Array.from(events).filter(
        (event) =>
          event.type === "thread.session-set" &&
          event.payload.session.updatedAt === h.completedAt &&
          event.payload.session.activeTurnId === null,
      );
      const checkpoints = Array.from(events).filter(
        (event) => event.type === "thread.turn-diff-completed",
      );
      expect(terminalSessions).toHaveLength(1);
      expect(checkpoints).toHaveLength(1);
      expect(h.nativeWork).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await h.close();
    }
  });
});
