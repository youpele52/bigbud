import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterSessionNotFoundError } from "../../Errors.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";

export function requirePiSession(
  sessions: Map<ThreadId, ActivePiSession>,
  threadId: ThreadId,
): Effect.Effect<ActivePiSession, ProviderAdapterSessionNotFoundError> {
  const session = sessions.get(threadId);
  return session
    ? Effect.succeed(session)
    : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
}
