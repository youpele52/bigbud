import type {
  ProviderActiveTurnInspection,
  ProviderKind,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";

/** Canonical implementation for adapters without an authoritative native query. */
export function unavailableActiveTurnInspection(
  provider: ProviderKind,
): (threadId: ThreadId, turnId: TurnId) => Effect.Effect<ProviderActiveTurnInspection> {
  return (_threadId, _turnId) =>
    Effect.succeed({
      status: "unavailable",
      observedAt: new Date().toISOString(),
      errorEvidence: {
        source: `${provider}.active-turn-inspection`,
        detail: "This provider does not expose an authoritative active-turn inspection query.",
      },
    });
}
