import type { ProviderKind, ProviderRuntimeEvent, ProviderSession } from "@bigbud/contracts";
import { EventId, ThreadId } from "@bigbud/contracts";
import { Effect, PubSub, Stream } from "effect";
import { vi } from "vitest";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";

export type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

export function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    runBackgroundReview: () => Effect.die(new Error("Unexpected background review in test")),
    startSessionFresh: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    inspectActiveTurn: () =>
      Effect.succeed({ status: "unavailable", observedAt: new Date().toISOString() }),
    listActiveTurnLiveness: () => Effect.succeed([]),
    recordTurnInspection: () => Effect.void,
    claimTurnTerminal: () => Effect.succeed(true),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    listSessionsForReconciliation: () =>
      Effect.gen(function* () {
        const sessions = yield* listSessions();
        return {
          sessions,
          availableProviders: new Set([providerName]),
          unavailableProviders: new Set(),
          directoryAvailable: true,
          diagnostics: [],
        };
      }),
    getCapabilities: () =>
      Effect.succeed({
        sessionModelSwitch: "in-session",
        ...(providerName === "claudeAgent" ? { conversationRewind: "unsupported" } : {}),
      }),
    rollbackConversation,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}
