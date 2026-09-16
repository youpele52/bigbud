import {
  ThreadId,
  TurnId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@bigbud/contracts";
import { Effect, PubSub, Stream } from "effect";
import { vi } from "vitest";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";

export function makeReactorProvider(
  input:
    | {
        readonly threadModelSelection?: ModelSelection;
        readonly sessionModelSwitch?: "unsupported" | "in-session";
        readonly interruptTurnFailure?: string;
        readonly interruptTurnLeavesSessionActive?: boolean;
        readonly stopSessionFailure?: string;
      }
    | undefined,
  now: string,
) {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  let nextSessionIndex = 1;
  const runtimeSessions: Array<ProviderSession> = [];
  const modelSelection = input?.threadModelSelection ?? {
    provider: "codex",
    model: "gpt-5-codex",
  };
  const startSession = vi.fn((_: unknown, providerInput: unknown) => {
    const sessionIndex = nextSessionIndex++;
    const resumeCursor =
      typeof providerInput === "object" && providerInput !== null && "resumeCursor" in providerInput
        ? providerInput.resumeCursor
        : undefined;
    const threadId =
      typeof providerInput === "object" &&
      providerInput !== null &&
      "threadId" in providerInput &&
      typeof providerInput.threadId === "string"
        ? ThreadId.makeUnsafe(providerInput.threadId)
        : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
    const session: ProviderSession = {
      provider: modelSelection.provider,
      status: "ready" as const,
      runtimeMode:
        typeof providerInput === "object" &&
        providerInput !== null &&
        "runtimeMode" in providerInput &&
        (providerInput.runtimeMode === "approval-required" ||
          providerInput.runtimeMode === "full-access")
          ? providerInput.runtimeMode
          : "full-access",
      ...(modelSelection.model !== undefined ? { model: modelSelection.model } : {}),
      threadId,
      resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
      createdAt: now,
      updatedAt: now,
    };
    runtimeSessions.push(session);
    return Effect.succeed(session);
  });
  const sendTurn = vi.fn((_: unknown) =>
    Effect.succeed({
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
    }),
  );
  const interruptTurn = vi.fn((interruptInput: unknown) => {
    if (input?.interruptTurnFailure) {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: modelSelection.provider,
          method: "interruptTurn",
          detail: input.interruptTurnFailure,
        }),
      );
    }
    if (!input?.interruptTurnLeavesSessionActive) {
      const threadId =
        typeof interruptInput === "object" &&
        interruptInput !== null &&
        "threadId" in interruptInput
          ? (interruptInput as { threadId?: ThreadId }).threadId
          : undefined;
      const session = runtimeSessions.find((entry) => entry.threadId === threadId);
      const sessionIndex = runtimeSessions.findIndex((entry) => entry.threadId === threadId);
      if (session && sessionIndex >= 0) {
        runtimeSessions[sessionIndex] = {
          ...session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    return Effect.void;
  });
  const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
  const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
  const stopSession = vi.fn((stopInput: unknown) =>
    Effect.gen(function* () {
      if (input?.stopSessionFailure) {
        return yield* new ProviderAdapterRequestError({
          provider: modelSelection.provider,
          method: "stopSession",
          detail: input.stopSessionFailure,
        });
      }
      const threadId =
        typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
          ? (stopInput as { threadId?: ThreadId }).threadId
          : undefined;
      if (!threadId) {
        return;
      }
      const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
      if (index >= 0) {
        runtimeSessions.splice(index, 1);
      }
    }),
  );
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: startSession as ProviderServiceShape["startSession"],
    runBackgroundReview: () => Effect.die(new Error("Unexpected background review in test")),
    startSessionFresh: startSession as ProviderServiceShape["startSessionFresh"],
    sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
    interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
    inspectActiveTurn: () =>
      Effect.succeed({ status: "unavailable", observedAt: new Date().toISOString() }),
    listActiveTurnLiveness: () => Effect.succeed([]),
    recordTurnInspection: () => Effect.void,
    claimTurnTerminal: () => Effect.succeed(true),
    respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
    respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
    stopSession: stopSession as ProviderServiceShape["stopSession"],
    listSessions: () => Effect.succeed(runtimeSessions),
    listSessionsForReconciliation: () =>
      Effect.succeed({
        sessions: runtimeSessions,
        availableProviders: new Set(runtimeSessions.map((session) => session.provider)),
        unavailableProviders: new Set(),
        directoryAvailable: true,
        diagnostics: [],
      }),
    getCapabilities: (_provider) =>
      Effect.succeed({
        sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
      }),
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };
  return {
    service,
    modelSelection,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
  };
}
