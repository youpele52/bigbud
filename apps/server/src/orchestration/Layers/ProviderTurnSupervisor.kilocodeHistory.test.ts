import { MessageId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { sendContinuation } from "./ProviderTurnSupervisor.continue.ts";
import type { RecoveryContext } from "./ProviderTurnSupervisor.state.ts";

describe("removed provider sleep recovery", () => {
  it.each(["selection", "session"] as const)(
    "settles an old Kilo %s intent without restarting or rebinding it",
    async (identity) => {
      const threadId = ThreadId.makeUnsafe("old-kilo");
      const thread = {
        id: threadId,
        modelSelection: {
          provider: identity === "selection" ? "kilocode" : "codex",
          model: "saved",
        },
        session: identity === "session" ? { providerName: "kilocode" } : null,
      } as OrchestrationThread;
      const before = structuredClone(thread);
      const dispatch = vi.fn(() => Effect.die("history cannot dispatch a continuation"));
      const transition = vi.fn(() => Effect.succeed(false));
      const recordAccepted = vi.fn(() =>
        Effect.die("history cannot create another recovery intent"),
      );
      const ctx = {
        engine: { getReadModel: () => Effect.succeed({ threads: [thread] }), dispatch },
        intents: { transition, recordAccepted },
        nowMs: () => 0,
      } as unknown as RecoveryContext;
      const intent = {
        threadId,
        messageId: MessageId.makeUnsafe("old-prompt"),
        provider: "kilocode",
        revision: 1,
        recoveryStatus: "awaiting-user",
      } as ThreadRecoveryIntent;

      await Effect.runPromise(sendContinuation(ctx, intent, { userAuthorized: true }));

      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: { disposition: "settled", recoveryStatus: "awaiting-user" },
        }),
      );
      expect(recordAccepted).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(thread).toEqual(before);
    },
  );
});
