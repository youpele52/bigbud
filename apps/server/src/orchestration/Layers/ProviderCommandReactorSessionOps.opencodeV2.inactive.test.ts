import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";

vi.mock("./ProviderCommandReactorSessionOps.threadContext.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProviderCommandReactorSessionOps.threadContext.ts")>()),
  resolveAndExportThreadContextPath: () => Effect.void,
}));

const message = (id: string, role: "user" | "assistant", text: string) => ({
  id: MessageId.makeUnsafe(id),
  role,
  text,
  turnId: TurnId.makeUnsafe("turn-earlier"),
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

// Gate G2a: a "fresh" V2 start reattaches the same native session, so an inactive V2 thread must
// resume its saved binding (which restores the saved native model) instead of starting fresh with
// the new selection and replaying the transcript onto retained native history.
it("restarts an inactive OpenCode V2 thread from its binding without a transcript replay", async () => {
  const h = makeSettingsHarness("opencodeV2");
  h.updateThread({
    modelSelection: { provider: "opencodeV2", subProviderID: "opencode", model: "old-model" },
    messages: [message("user-1", "user", "first"), message("assistant-1", "assistant", "answer")],
    session: {
      threadId,
      status: "stopped",
      providerName: "opencodeV2",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: createdAt,
    },
  } as never);

  await Effect.runPromise(
    sendTurnForThread(h.services)({
      threadId,
      createdAt,
      messageText: "next question",
      requestMessageId: MessageId.makeUnsafe("user-2"),
      modelSelection: { provider: "opencodeV2", subProviderID: "opencode", model: "new-model" },
    }),
  );

  expect(h.startSessionFresh).not.toHaveBeenCalled();
  expect(h.startSession).toHaveBeenCalledTimes(1);
  expect(h.sendTurn).toHaveBeenCalledTimes(1);
  const input = (h.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "";
  expect(input).toContain("next question");
  expect(input).not.toContain("answer");
});

// A fork copies the transcript (`turnId: null`) into a new thread whose native session is empty,
// so its first turn must start fresh and replay the copied transcript.
it("seeds a forked OpenCode V2 thread from its copied transcript", async () => {
  const h = makeSettingsHarness("opencodeV2");
  const copied = (id: string, role: "user" | "assistant", text: string) => ({
    ...message(id, role, text),
    turnId: null,
  });
  h.updateThread({
    modelSelection: { provider: "opencodeV2", subProviderID: "opencode", model: "old-model" },
    messages: [copied("user-1", "user", "first"), copied("assistant-1", "assistant", "answer")],
    forkOrigin: { forkPointMessageId: "assistant-1", reason: "manual", failureEventId: null },
    // As projected by the fork's own turn-start-requested event before the reactor sends.
    session: {
      threadId,
      status: "starting",
      providerName: "opencodeV2",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: createdAt,
    },
  } as never);

  await Effect.runPromise(
    sendTurnForThread(h.services)({
      threadId,
      createdAt,
      messageText: "next question",
      requestMessageId: MessageId.makeUnsafe("user-2"),
      modelSelection: { provider: "opencodeV2", subProviderID: "opencode", model: "old-model" },
    }),
  );

  expect(h.startSessionFresh).toHaveBeenCalledTimes(1);
  const input = (h.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input ?? "";
  expect(input).toContain("next question");
  expect(input).toContain("answer");
});
