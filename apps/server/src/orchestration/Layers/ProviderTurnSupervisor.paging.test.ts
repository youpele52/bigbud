import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { RECOVERY_INTENT_PAGE_SIZE } from "./ProviderTurnSupervisor.intents.ts";
import {
  RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS,
  type InspectionOutcome,
} from "./ProviderTurnSupervisor.policy.logic.ts";
import {
  observeTurnsAcrossSleep,
  recordTurnFailure,
  runRecoveryPass,
} from "./ProviderTurnSupervisor.recovery.ts";
import {
  failureAt,
  makeRecoveryHarness,
  recoveryTestLayer,
  SLEPT_AT_MS,
  WOKE_AT_MS,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import { handleBackendStart } from "./ProviderTurnSupervisor.startup.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const LONG_AGO = "2026-10-01T09:00:00.000Z";

/** `count` intents on other threads, last updated long ago, optionally with a sent attempt. */
const insertOldIntents = (input: {
  readonly count: number;
  readonly status: string;
  readonly detail?: object;
  readonly sentAttempt?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let index = 0; index < input.count; index += 1) {
      const thread = `old-thread-${String(index).padStart(4, "0")}`;
      yield* sql`INSERT INTO thread_recovery_intents (
          thread_id, message_id, provider, turn_id, disposition, recovery_status,
          recovery_detail_json, created_at, updated_at
        ) VALUES (
          ${thread}, 'old-message', 'claudeAgent', 'old-turn', 'active', ${input.status},
          ${JSON.stringify(input.detail ?? {})}, ${LONG_AGO}, ${LONG_AGO}
        )`;
      if (input.sentAttempt) {
        yield* sql`INSERT INTO provider_dispatch_attempts (
            attempt_id, thread_id, message_id, intent_revision, payload_digest, provider,
            state, prepared_at, may_have_been_sent_at, updated_at
          ) VALUES (
            ${`attempt-${index}`}, ${thread}, 'old-message', 0, 'digest', 'claudeAgent',
            'may-have-been-sent', ${LONG_AGO}, ${LONG_AGO}, ${LONG_AGO}
          )`;
      }
    }
  });

const countActive = (status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM thread_recovery_intents
      WHERE disposition = 'active' AND recovery_status = ${status}
        AND thread_id LIKE 'old-thread-%'`;
    return rows[0]?.count ?? 0;
  });

describe("prompts nobody answers never starve a recovery pass", () => {
  it.effect("a new cut turn is evaluated behind more old prompts than one page holds", () =>
    provided(
      Effect.gen(function* () {
        yield* insertOldIntents({
          count: RECOVERY_INTENT_PAGE_SIZE + 1,
          status: "awaiting-user",
          detail: { reason: "tool-in-flight" },
        });
        const h = yield* makeRecoveryHarness();
        yield* h.sleep.recordDesktopHint({
          kind: "offline",
          sequence: 1,
          occurredAt: WOKE_AT_MS,
          online: false,
        });
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        assert.strictEqual(h.turnStarts().length, 0);
        yield* h.sleep.recordDesktopHint({
          kind: "online",
          sequence: 2,
          occurredAt: WOKE_AT_MS + 5_000,
          online: true,
        });
        h.advance(5_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 1);
      }),
    ),
  );

  it.effect("the newest 'no activity' prompt still sees the provider continue", () =>
    provided(
      Effect.gen(function* () {
        yield* insertOldIntents({
          count: 60,
          status: "awaiting-user",
          detail: { reason: "no-activity-after-wake" },
        });
        let inspection: InspectionOutcome = "unavailable";
        const h = yield* makeRecoveryHarness({ inspect: () => Effect.succeed(inspection) });
        yield* h.seedRunningTurn;
        yield* observeTurnsAcrossSleep(h.ctx, {
          epochId: 1,
          startedAtMs: SLEPT_AT_MS,
          endedAtMs: WOKE_AT_MS,
          durationMs: 600_000,
          sources: ["server-gap"],
        });
        h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.thread().recovery?.reason, "no-activity-after-wake");
        // The provider reports the turn running again; the prompt is read despite 60 older ones.
        inspection = "running";
        h.advance(20_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "provider-continued");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );
});

describe("a backend start reaches every leftover intent", () => {
  it.effect("an ordinary start suspends more leftovers than one page holds", () =>
    provided(
      Effect.gen(function* () {
        yield* insertOldIntents({ count: 2 * RECOVERY_INTENT_PAGE_SIZE + 101, status: "none" });
        const h = yield* makeRecoveryHarness();
        yield* handleBackendStart(h.ctx, {
          startReason: undefined,
          processStartedAtMs: WOKE_AT_MS + 5_000,
        });
        assert.strictEqual(yield* countActive("none"), 0);
      }),
    ),
  );

  it.effect("a post-wake restart prompts for more uncertain turns than one page holds", () =>
    provided(
      Effect.gen(function* () {
        yield* insertOldIntents({
          count: RECOVERY_INTENT_PAGE_SIZE + 1,
          status: "none",
          sentAttempt: true,
        });
        const h = yield* makeRecoveryHarness();
        yield* handleBackendStart(h.ctx, {
          startReason: "resume-probe-restart",
          processStartedAtMs: WOKE_AT_MS + 5_000,
        });
        assert.strictEqual(yield* countActive("awaiting-user"), RECOVERY_INTENT_PAGE_SIZE + 1);
        assert.strictEqual(yield* countActive("none"), 0);
      }),
    ),
  );
});
