import { type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../src/provider/Errors.ts";

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
