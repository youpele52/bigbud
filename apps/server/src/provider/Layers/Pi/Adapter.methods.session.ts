import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProviderAdapterSessionNotFoundError } from "../../Errors.ts";
import { requireLiveAdapterSession } from "../../providerSessionLookup.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";

export function requirePiSession(
  sessions: Map<ThreadId, ActivePiSession>,
  threadId: ThreadId,
): Effect.Effect<ActivePiSession, ProviderAdapterSessionNotFoundError> {
  return requireLiveAdapterSession({
    provider: PROVIDER,
    threadId,
    session: sessions.get(threadId),
  });
}
