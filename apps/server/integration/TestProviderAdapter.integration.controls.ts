import type { ProviderSession, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { SessionState } from "./TestProviderAdapter.integration.types.ts";

export function makeTestProviderAdapterControls(
  sessions: Map<ThreadId, SessionState>,
  sentTurnInputs: ReadonlyArray<string>,
) {
  let listSessionFailuresRemaining = 0;

  return {
    listSessions: () =>
      Effect.suspend(() => {
        if (listSessionFailuresRemaining > 0) {
          listSessionFailuresRemaining -= 1;
          return Effect.die(new Error("Test provider listSessions failure"));
        }
        return Effect.sync(() => Array.from(sessions.values(), (state) => state.session));
      }),
    getSentTurnInputs: (): ReadonlyArray<string> => [...sentTurnInputs],
    setSession: (session: ProviderSession): Effect.Effect<void, never> =>
      Effect.sync(() => {
        const state = sessions.get(session.threadId);
        if (state) {
          state.session = session;
          return;
        }
        sessions.set(session.threadId, {
          session,
          snapshot: { threadId: session.threadId, turns: [] },
          turnCount: 0,
          queuedResponses: [],
          rollbackCalls: [],
        });
      }),
    removeSession: (threadId: ThreadId): Effect.Effect<void, never> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
    failNextListSessions: (): Effect.Effect<void, never> =>
      Effect.sync(() => {
        listSessionFailuresRemaining += 1;
      }),
  };
}
