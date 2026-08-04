import type { ThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Exit, Schema } from "effect";

import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { ThreadRetentionShape } from "../Services/ThreadRetention.ts";

export const persistThreadRetentionPolicy = Effect.fn("ThreadRetention.persistPolicy")(function* <
  A,
  SettingsError,
  AuthorityError,
>(input: {
  readonly policy: ThreadRetentionPolicy;
  readonly previousPolicy: ThreadRetentionPolicy;
  readonly setSettings: (policy: ThreadRetentionPolicy) => Effect.Effect<A, SettingsError>;
  readonly setAuthority: (policy: ThreadRetentionPolicy) => Effect.Effect<void, AuthorityError>;
}) {
  const updated = yield* input.setSettings(input.policy);
  const authorityExit = yield* Effect.exit(input.setAuthority(input.policy));
  if (Exit.isSuccess(authorityExit)) return updated;
  const rollbackExit = yield* Effect.exit(input.setSettings(input.previousPolicy));
  if (Exit.isFailure(rollbackExit)) return yield* Effect.failCause(rollbackExit.cause);
  return yield* Effect.failCause(authorityExit.cause);
});

const retentionError = (code: ServerThreadRetentionError["code"], message: string) =>
  new ServerThreadRetentionError({ code, message });

export function makeSetThreadRetentionPolicy(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly settings: ServerSettingsShape;
  readonly getPolicy: Effect.Effect<ThreadRetentionPolicy, ProjectionRepositoryError>;
}): ThreadRetentionShape["setPolicy"] {
  return (request) =>
    Effect.gen(function* () {
      if (!input.settings.setThreadRetentionPolicy) {
        return yield* retentionError("failed", "Thread retention settings are unavailable.");
      }
      const previousPolicy = yield* input.getPolicy;
      const persist = (policy: ThreadRetentionPolicy) =>
        persistThreadRetentionPolicy({
          policy,
          previousPolicy,
          setSettings: input.settings.setThreadRetentionPolicy!,
          setAuthority: (nextPolicy) =>
            input.repository.setPolicyAuthority({
              policy: nextPolicy,
              source: "explicit",
              updatedAt: new Date().toISOString(),
            }),
        });
      if (request.policy === "never") return yield* persist("never");
      if (process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1") {
        return yield* retentionError(
          "disabled",
          "Thread retention is disabled by the server administrator.",
        );
      }
      const result = yield* input.repository.consumePolicyChallenge({
        token: request.challengeToken,
        policy: request.policy,
        consumedAt: new Date().toISOString(),
      });
      if (result === "expired") {
        return yield* retentionError(
          "challenge_expired",
          "The confirmation expired. Preview again.",
        );
      }
      if (result === "already_consumed") {
        return yield* retentionError("challenge_consumed", "The confirmation was already used.");
      }
      if (result !== "consumed") {
        return yield* retentionError(
          "challenge_invalid",
          "The confirmation no longer matches this policy change.",
        );
      }
      return yield* persist(request.policy);
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(ServerThreadRetentionError)(error)
          ? error
          : retentionError("failed", "Failed to update thread retention policy."),
      ),
    );
}
