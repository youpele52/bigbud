import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandId, MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { dispatchTurn, THREAD } from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

// Replace only external context sources, not composition or validation.
vi.mock("./ProviderTurnMemoryContext.ts", () => ({
  readProviderMemoryContext: () => Effect.succeed("DETERMINISTIC_MEMORY"),
}));
vi.mock("../../orchestration-tools/ThreadSystemResourcesTool.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../orchestration-tools/ThreadSystemResourcesTool.ts")
  >()),
  getSystemResources: () => Effect.succeed({ available: false, reason: "DETERMINISTIC_RESOURCE" }),
}));

const now = () => new Date().toISOString();
const current = (id: string) => `${id}_START${"x".repeat(240_000)}${id}_END`;

describe("large current requests through reactor composition", () => {
  registerProviderCommandReactorTestCleanup();
  afterEach(() => vi.unstubAllEnvs());

  it.each(["true", "false"])(
    "preserves fresh, live and rebuilt requests with capability context %s",
    async (enabled) => {
      vi.stubEnv("BIGBUD_CAPABILITY_CONTEXT_ENABLED", enabled);
      const harness = await createHarness();
      const referenceId = ThreadId.makeUnsafe("reference-thread");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-reference"),
          threadId: referenceId,
          projectId: (await Effect.runPromise(harness.engine.getReadModel())).projects[0]!.id,
          title: "ATTACHED_THREAD",
          modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe("reference-text"),
          threadId: referenceId,
          messageId: MessageId.makeUnsafe("reference-answer"),
          turnId: TurnId.makeUnsafe("reference-turn"),
          delta: "REFERENCE_BODY",
          createdAt: now(),
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("reference-complete"),
          threadId: referenceId,
          messageId: MessageId.makeUnsafe("reference-answer"),
          turnId: TurnId.makeUnsafe("reference-turn"),
          createdAt: now(),
        }),
      );
      const attachments = [
        {
          type: "thread" as const,
          id: "reference",
          name: "ATTACHED_THREAD",
          mimeType: "application/x-bigbud-thread-reference",
          sizeBytes: 0,
          threadId: referenceId,
          title: "ATTACHED_THREAD",
        },
      ] as const;
      const decodeSend = (index: number) =>
        Schema.decodeUnknownSync(ProviderSendTurnInput)(harness.sendTurn.mock.calls[index]?.[0])
          .input!;
      const check = (text: string, request: string) => {
        expect(text).toContain(request);
        expect(text.split(request)).toHaveLength(2);
        expect(text.length).toBeGreaterThan(240_000);
        expect(text).toContain("<attached_threads>");
        expect(text).toContain("REFERENCE_BODY");
      };

      await dispatchTurn(harness, "fresh", current("FRESH"), attachments);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const fresh = decodeSend(0);
      check(fresh, current("FRESH"));
      expect(fresh).toContain("DETERMINISTIC_MEMORY");
      expect(fresh).toContain("DETERMINISTIC_RESOURCE");
      expect(fresh).toContain(
        enabled === "true" ? "<bigbud_capability_lp>" : "Current thread context:",
      );
      expect(fresh).not.toContain("Transcript context:");
      await harness.drain();
      const history = `REPLAYABLE_HISTORY${"h".repeat(119_000)}`;
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe("history-delta"),
          threadId: THREAD,
          messageId: MessageId.makeUnsafe("history"),
          turnId: TurnId.makeUnsafe("turn-1"),
          delta: history,
          createdAt: now(),
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("history-complete"),
          threadId: THREAD,
          messageId: MessageId.makeUnsafe("history"),
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: now(),
        }),
      );
      await settleActiveTurn(harness.engine, "settle-fresh", now());

      await dispatchTurn(harness, "live", current("LIVE"), attachments);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const live = decodeSend(1);
      check(live, current("LIVE"));
      expect(live).not.toContain("REPLAYABLE_HISTORY");
      expect(live).not.toContain("Transcript context:");
      await harness.drain();
      await settleActiveTurn(harness.engine, "settle-live", now());
      await Effect.runPromise(harness.stopSession({ threadId: THREAD }));

      await dispatchTurn(harness, "rebuilt", current("REBUILT"), attachments);
      await waitFor(() => harness.sendTurn.mock.calls.length === 3);
      const rebuilt = decodeSend(2);
      check(rebuilt, current("REBUILT"));
      expect(rebuilt).toContain(history);
      expect(rebuilt).not.toContain(current("LIVE"));
      expect(rebuilt).not.toContain(current("FRESH"));
      expect(rebuilt).toContain("DETERMINISTIC_MEMORY");
      expect(rebuilt).toContain("DETERMINISTIC_RESOURCE");
      expect(rebuilt).toContain(
        enabled === "true" ? "<bigbud_capability_lp>" : "Current thread context:",
      );
      const replayStart = rebuilt.indexOf(
        "Continue this conversation using the transcript context below.",
      );
      const currentStart = rebuilt.indexOf(current("REBUILT"));
      expect(replayStart).toBeGreaterThanOrEqual(0);
      expect(currentStart - replayStart).toBeLessThanOrEqual(120_000);
      expect(rebuilt.indexOf("DETERMINISTIC_RESOURCE")).toBeLessThan(
        rebuilt.indexOf("DETERMINISTIC_MEMORY"),
      );
      expect(rebuilt.indexOf("DETERMINISTIC_MEMORY")).toBeLessThan(replayStart);
      expect(rebuilt.indexOf("<attached_threads>")).toBeGreaterThan(currentStart);
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(3);
      expect(harness.startSession).toHaveBeenCalledTimes(2);
    },
  );
});
