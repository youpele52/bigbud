/**
 * Adapter session lookup at request admission. A missing or dead session is found before anything
 * is written to the provider, so the turn never started: it fails `session-dead`, which bounded
 * in-place recovery may resend (plan D12, "proven before dispatch").
 *
 * @module providerSessionLookup
 */
import { Effect } from "effect";

import { ProviderAdapterSessionNotFoundError } from "./Errors.ts";

export function requireLiveAdapterSession<S>(input: {
  readonly provider: string;
  readonly threadId: string;
  readonly session: S | undefined;
  readonly isLive?: (session: S) => boolean;
}): Effect.Effect<S, ProviderAdapterSessionNotFoundError> {
  const { session } = input;
  return session !== undefined && (input.isLive?.(session) ?? true)
    ? Effect.succeed(session)
    : Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: input.provider,
          threadId: input.threadId,
          failureClass: "session-dead",
        }),
      );
}
