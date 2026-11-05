import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Effect, PubSub, Ref, Stream } from "effect";

import { ProviderAdapterSessionNotFoundError } from "../../Errors.ts";
import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import { PROVIDER_SUBAGENT_CAPABILITIES } from "../../providerSubagents.capabilities.ts";
import { museValidationError } from "./Client.errors.ts";
import { makeMuseApprovalResponder } from "./Adapter.approvals.ts";
import { makeMuseInterruptTurn } from "./Adapter.controls.ts";
import { makeMuseInspectActiveTurn } from "./Adapter.inspection.ts";
import { makeMuseUserInputResponder } from "./Adapter.questions.ts";
import { makeMuseSendTurn } from "./Adapter.sendTurn.ts";
import { museProviderSession, stampMuseEvent } from "./Adapter.sessionView.ts";
import { makeMuseStartSession } from "./Adapter.startSession.ts";
import { closeMuseResources } from "./Adapter.resources.ts";
import {
  type MuseAdapterContext,
  type MuseAdapterDeps,
  type MuseSessionState,
} from "./Adapter.types.ts";

export type { MuseAdapterDeps, MuseBridgeHandle } from "./Adapter.types.ts";

type Sessions = Map<ThreadId, MuseSessionState>;

/**
 * Muse adapter assembly. Concerns live in dot-notation modules:
 * startSession (Adapter.startSession.ts), sendTurn (Adapter.sendTurn.ts),
 * Stop (Adapter.controls.ts), inspection (Adapter.inspection.ts), approvals
 * (Adapter.approvals.ts) and questions (Adapter.questions.ts).
 */
export const makeMuseAdapterShape = Effect.fn("makeMuseAdapterShape")(function* (
  deps: MuseAdapterDeps,
) {
  const sessionsRef = yield* Ref.make<Sessions>(new Map());
  const eventsPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const publish = (event: ProviderRuntimeEvent) => PubSub.publish(eventsPubSub, event);

  const getSession = (threadId: ThreadId) =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => {
        const session = sessions.get(threadId);
        return session && !session.closed
          ? Effect.succeed(session)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: "muse", threadId }));
      }),
    );

  const requireUsable = Effect.fn("Muse.requireUsable")(function* () {
    const settings = yield* deps.getSettings;
    if (!settings.enabled) {
      return yield* museValidationError(
        "provider",
        "Muse Code is disabled in bigbud settings.",
        "provider-unavailable",
      );
    }
    if (!deps.platformQualified) {
      return yield* museValidationError(
        "provider",
        "Muse Code is not yet qualified on this platform; it is unavailable here until that platform passes qualification.",
        "provider-unavailable",
      );
    }
    return settings;
  });

  const ctx: MuseAdapterContext = { deps, sessionsRef, publish, getSession, requireUsable };

  const shape: MuseAdapterShape = {
    provider: "muse",
    capabilities: {
      supportsAttachments: false,
      sessionModelSwitch: "in-session",
      sessionRecovery: "resume-restart",
      conversationRewind: "unsupported",
      conversationFork: "unsupported",
      supportsSteer: false,
      turnControl: {
        nativeSteer: false,
        interruptTarget: "exact-turn",
        activeTurnInspection: "authoritative",
        continuation: false,
      },
      subagents: PROVIDER_SUBAGENT_CAPABILITIES.muse,
    },

    startSession: makeMuseStartSession(ctx),
    sendTurn: makeMuseSendTurn(ctx),
    interruptTurn: makeMuseInterruptTurn(ctx),
    inspectActiveTurn: makeMuseInspectActiveTurn(ctx),
    respondToRequest: makeMuseApprovalResponder(ctx),
    respondToUserInput: makeMuseUserInputResponder(ctx),

    stopSession: Effect.fn("Muse.stopSession")(function* (threadId) {
      const sessions = yield* Ref.get(sessionsRef);
      const session = sessions.get(threadId);
      if (!session || session.closed) return;
      session.closed = true;
      yield* Ref.update(sessionsRef, (current) => {
        const next = new Map(current);
        if (next.get(threadId) === session) next.delete(threadId);
        return next;
      });
      yield* Effect.promise(() =>
        closeMuseResources([session.cleanupBridge, () => session.transport.close()]),
      );
      yield* publish(
        stampMuseEvent(
          {
            eventId: `muse-session-exit-${session.nativeSessionId}`,
            provider: "muse",
            threadId,
            createdAt: new Date().toISOString(),
            type: "session.exited",
            payload: { reason: "stopped", recoverable: true },
          } as ProviderRuntimeEvent,
          session.sessionEpoch,
        ),
      );
    }),

    listSessions: () =>
      Ref.get(sessionsRef).pipe(
        Effect.map((sessions) =>
          [...sessions.values()].filter((s) => !s.closed).map(museProviderSession),
        ),
      ),
    hasSession: (threadId) =>
      Ref.get(sessionsRef).pipe(
        Effect.map((sessions) => {
          const s = sessions.get(threadId);
          return s !== undefined && !s.closed;
        }),
      ),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: () =>
      Effect.fail(
        museValidationError(
          "rollbackThread",
          "Muse conversation rewind is not supported.",
          "invalid-request",
        ),
      ),
    stopAll: () =>
      Effect.gen(function* () {
        const sessions = [...(yield* Ref.get(sessionsRef)).keys()];
        for (const threadId of sessions) yield* shape.stopSession(threadId);
      }),
    streamEvents: Stream.fromPubSub(eventsPubSub),
  };
  return shape;
});
