import { type ProviderKind, type ThreadId, type TurnId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../src/provider/Errors.ts";
import type { SessionState } from "./TestProviderAdapter.integration.types.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sessionNotFound(
  provider: ProviderKind,
  threadId: ThreadId,
): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider,
    threadId: String(threadId),
  });
}

export function missingSessionEffect(
  provider: ProviderKind,
  threadId: ThreadId,
): Effect.Effect<never, ProviderAdapterError> {
  return Effect.fail(sessionNotFound(provider, threadId));
}

/** Like a real provider, a turn whose completion is deferred stays the session's active turn. */
export function markDeferredTurnRunning(state: SessionState, turnId: TurnId): void {
  state.session = {
    ...state.session,
    status: "running",
    activeTurnId: turnId,
    updatedAt: nowIso(),
  };
}
