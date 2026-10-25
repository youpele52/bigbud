/**
 * CopilotAdapter.session.steer — native steering of the running turn.
 *
 * Copilot interjects an `immediate` message into the in-progress agent loop.
 * Copilot gives every assistant step its own turn ID, so the guard is the
 * session-level active turn rather than an exact turn-ID match.
 *
 * @module CopilotAdapter.session.steer
 */
import { Effect } from "effect";

import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import { type CopilotAdapterShape } from "../../Services/Copilot/Adapter.ts";
import { type SessionOpsDeps } from "./Adapter.session.start.ts";
import {
  PROVIDER,
  isSessionNotFoundError,
  sendOnCopilotSession,
  toMessage,
} from "./Adapter.types.ts";

export const makeSteerTurn =
  (deps: SessionOpsDeps): NonNullable<CopilotAdapterShape["steerTurn"]> =>
  (threadId, input, _turnId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      if (!record.activeTurnId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "steerTurn",
          issue: "There is no active GitHub Copilot turn to steer.",
        });
      }
      record.updatedAt = new Date().toISOString();
      yield* Effect.tryPromise({
        try: () => sendOnCopilotSession(record, { prompt: input, mode: "immediate" }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.send",
            detail: toMessage(cause, "Failed to steer the GitHub Copilot turn."),
            ...(isSessionNotFoundError(cause) ? { failureClass: "session-dead" as const } : {}),
            cause,
          }),
      });
    });
