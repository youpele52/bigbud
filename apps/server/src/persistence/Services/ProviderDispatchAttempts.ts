/**
 * ProviderDispatchAttemptRepository - delivery progress of each provider dispatch attempt.
 *
 * `prepared` and then `may-have-been-sent` are durable before the adapter call, so a crash or
 * a backend restart after the call can never look like "never sent". `provider-acknowledged`
 * is written together with the turn's liveness and runtime binding, in one transaction.
 *
 * @module ProviderDispatchAttemptRepository
 */
import type { MessageId, ProviderKind, ThreadId, TurnId } from "@bigbud/contracts";
import type { ProviderDispatchAttemptState } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface ProviderDispatchAttempt {
  readonly attemptId: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly intentRevision: number;
  readonly payloadDigest: string;
  readonly provider: ProviderKind | null;
  readonly turnId: TurnId | null;
  readonly state: ProviderDispatchAttemptState;
  readonly preparedAt: string;
  readonly mayHaveBeenSentAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly updatedAt: string;
}

export interface ProviderDispatchAttemptRepositoryShape {
  /**
   * Claims `prepared` for the intent's dispatch, then moves it to `may-have-been-sent`.
   * Returns none when the turn has no active intent (turns accepted before migration 137, or
   * internal sends); those are not tracked. An intent keeps at most one unacknowledged
   * attempt: a resend reuses it.
   */
  readonly markMayHaveBeenSent: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly provider: ProviderKind;
    readonly payloadDigest: string;
    readonly at: string;
  }) => Effect.Effect<Option.Option<ProviderDispatchAttempt>, PersistenceSqlError>;
  /**
   * Runs `alongside` (the liveness and binding writes) and marks the attempt
   * `provider-acknowledged`, binding the intent's turn, in one transaction.
   */
  readonly acknowledgeWith: <E, R>(
    input: {
      readonly attemptId: string;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly provider: ProviderKind;
      readonly at: string;
    },
    alongside: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, E | PersistenceSqlError, R>;
  readonly latestForIntent: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<Option.Option<ProviderDispatchAttempt>, PersistenceSqlError>;
}

export class ProviderDispatchAttemptRepository extends ServiceMap.Service<
  ProviderDispatchAttemptRepository,
  ProviderDispatchAttemptRepositoryShape
>()("bigbud/persistence/Services/ProviderDispatchAttemptRepository") {}
