import { EventId, MessageId, TurnId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { REMOTE_SHELL_TOOL_LABEL } from "./ProviderTurnSupervisor.classify.logic.ts";
import { SLEEP_CONTINUATION_TEXT, continuationFailed } from "./ProviderTurnSupervisor.continue.ts";
import { RuntimeActivityGovernor } from "./ProviderRuntimeIngestion.activityGovernor.ts";
import { observeRuntimeEvent } from "./ProviderTurnSupervisor.observe.ts";
import { recordTurnFailure, runRecoveryPass } from "./ProviderTurnSupervisor.recovery.ts";
import {
  toolActivity,
  toolItem,
  turnStarted,
  upsertActivities,
} from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";
import {
  failureAt,
  makeRecoveryHarness,
  recoveryTestLayer,
  threadId,
  turnId,
  WOKE_AT_MS,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";

const scenario = <A, E>(effect: Effect.Effect<A, E, never>) => effect;
const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  scenario(effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>);

/** A streaming turn is cut at wake: the provider's request failed when timers fired. */
const cutAtWake = (h: Awaited<Effect.Success<ReturnType<typeof makeRecoveryHarness>>>) =>
  Effect.gen(function* () {
    yield* h.seedRunningTurn;
    yield* h.sleepAndWake;
    h.endTurnWithError();
    yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
  });

describe("sleep recovery coordinator", () => {
  it.effect("continues a streaming turn cut by sleep exactly once, then settles on bind", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* cutAtWake(h);
        const starts = h.turnStarts();
        assert.strictEqual(starts.length, 1);
        const start = starts[0]!;
        assert.isTrue(start.type === "thread.turn.start");
        if (start.type !== "thread.turn.start") return;
        assert.strictEqual(start.message.text, SLEEP_CONTINUATION_TEXT);
        assert.deepStrictEqual(
          start.message.originSegments?.map((segment) => [segment.kind, segment.actor]),
          [["sleepRecovery", "automation"]],
        );
        const continuing = yield* h.intent();
        assert.strictEqual(continuing.recoveryStatus, "continuing");
        assert.strictEqual(continuing.attemptCount, 1);
        assert.strictEqual(h.thread().recovery?.status, "continuing");
        // A second pass while continuing sends nothing more.
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 1);
        // The continuation binds a turn.
        const continuationId = continuing.continuationMessageId!;
        const linked = Option.getOrThrow(
          yield* h.intents.get({ threadId, messageId: continuationId }),
        );
        assert.strictEqual(linked.detail.continuationOf, continuing.messageId);
        const attempt = yield* h.attempts.markMayHaveBeenSent({
          threadId,
          messageId: continuationId,
          provider: "claudeAgent",
          payloadDigest: "c",
          at: new Date(h.nowMs()).toISOString(),
        });
        yield* h.attempts.acknowledgeWith(
          {
            attemptId: Option.getOrThrow(attempt).attemptId,
            threadId,
            messageId: continuationId,
            turnId: TurnId.makeUnsafe("continuation-turn"),
            provider: "claudeAgent",
            at: new Date(h.nowMs()).toISOString(),
          },
          Effect.void,
        );
        yield* runRecoveryPass(h.ctx);
        const settled = yield* h.intent();
        assert.strictEqual(settled.disposition, "settled");
        assert.strictEqual(settled.recoveryStatus, "continued");
        assert.isNull(h.thread().recovery);
      }),
    ),
  );

  it.effect("asks, naming the tool, and sends nothing when a tool may have been running", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        h.patchThread({
          activities: [
            {
              id: EventId.makeUnsafe("tool"),
              tone: "tool",
              kind: "tool.started",
              summary: "Run migrations started",
              payload: { itemType: "command_execution", itemId: "item-1" },
              turnId,
              createdAt: new Date(WOKE_AT_MS - 700_000).toISOString(),
            },
          ],
        });
        yield* cutAtWake(h);
        assert.strictEqual(h.turnStarts().length, 0);
        const intent = yield* h.intent();
        assert.strictEqual(intent.recoveryStatus, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.reason, "tool-in-flight");
        assert.strictEqual(h.thread().recovery?.toolSummary, "Run migrations");
      }),
    ),
  );

  it.effect("asks, not continues, when a long turn's late tool start was throttled away", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        // 21 tools ran and completed, then a 22nd started: the work log drops that start.
        const rows = [];
        for (let index = 0; index < 21; index += 1) {
          for (const kind of ["tool.started", "tool.completed"] as const) {
            rows.push(toolActivity({ kind, title: `Step ${index}`, itemId: `i-${index}`, turnId }));
          }
        }
        rows.push(toolActivity({ kind: "tool.started", title: "Deploy", itemId: "late", turnId }));
        const activities = upsertActivities(
          new RuntimeActivityGovernor().take({ threadId, turnId, activities: rows }),
        );
        assert.isFalse(activities.some((row) => row.summary === "Deploy started"));
        h.patchThread({ activities: [...activities] });
        yield* cutAtWake(h);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.reason, "tool-in-flight");
      }),
    ),
  );

  it.effect("names the throttled tool from the coordinator's own runtime tracking", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* observeRuntimeEvent(h.ctx, turnStarted(threadId, turnId));
        for (let index = 0; index < 21; index += 1) {
          for (const type of ["item.started", "item.completed"] as const) {
            yield* observeRuntimeEvent(
              h.ctx,
              toolItem(type, threadId, turnId, `i-${index}`, `Step ${index}`),
            );
          }
        }
        yield* observeRuntimeEvent(
          h.ctx,
          toolItem("item.started", threadId, turnId, "late", "Deploy"),
        );
        yield* cutAtWake(h);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual(h.thread().recovery?.toolSummary, "Deploy");
      }),
    ),
  );

  it.effect("asks when the remote agent may still be running the thread's shell command", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json)
          VALUES (${`shell:${threadId}`}, ${JSON.stringify({ state: "outcome-unknown" })})`;
        yield* cutAtWake(h);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual(h.thread().recovery?.reason, "tool-in-flight");
        assert.strictEqual(h.thread().recovery?.toolSummary, REMOTE_SHELL_TOOL_LABEL);
      }),
    ),
  );

  it.effect("observes a provider that continued on its own and sends nothing", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.advance(5_000);
        h.ctx.memory.lastProgressAtMs.set(threadId, h.nowMs());
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(h.nowMs()));
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "provider-continued");
        assert.strictEqual(h.thread().recovery?.status, "provider-continued");
        // The session stays in error and no completion ever arrives: after 120 s of quiet on
        // the idle thread the user is asked. Nothing is sent from this state.
        h.advance(60_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "provider-continued");
        h.advance(60_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.reason, "interrupted-by-sleep");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("waits for the network without counting an attempt, then continues", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.sleep.recordDesktopHint({
          kind: "offline",
          sequence: 1,
          occurredAt: WOKE_AT_MS,
          online: false,
        });
        yield* cutAtWake(h);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).attemptCount, 0);
        assert.strictEqual(h.thread().recovery?.status, "interrupted-by-sleep");
        yield* h.sleep.recordDesktopHint({
          kind: "online",
          sequence: 2,
          occurredAt: WOKE_AT_MS + 5_000,
          online: true,
        });
        h.advance(5_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 1);
        assert.strictEqual((yield* h.intent()).attemptCount, 1);
      }),
    ),
  );

  it.effect("parks after three failed continuations", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* cutAtWake(h);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const current = yield* h.intent();
          assert.strictEqual(current.recoveryStatus, "continuing");
          assert.strictEqual(current.attemptCount, attempt);
          yield* continuationFailed(h.ctx, current, "provider unavailable");
          yield* runRecoveryPass(h.ctx);
        }
        assert.strictEqual(h.turnStarts().length, 3);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "parked");
        assert.strictEqual(h.thread().recovery?.status, "parked");
      }),
    ),
  );

  it.effect("never resumes a turn the user stopped before the sleep", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* h.intents.revokeForThread({
          threadId,
          at: new Date(WOKE_AT_MS - 900_000).toISOString(),
        });
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).disposition, "revoked");
      }),
    ),
  );

  it.effect("cancels recovery when the user sends a message after the cut", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.sleep.recordDesktopHint({
          kind: "offline",
          sequence: 1,
          occurredAt: WOKE_AT_MS,
          online: false,
        });
        yield* cutAtWake(h);
        // The user's own turn start supersedes the cut turn in the command transaction.
        yield* h.intents.settleSupersededByTurnStart({
          threadId,
          messageId: MessageId.makeUnsafe("user-follow-up"),
          at: new Date(h.nowMs()).toISOString(),
        });
        yield* h.sleep.recordDesktopHint({
          kind: "online",
          sequence: 2,
          occurredAt: WOKE_AT_MS + 5_000,
          online: true,
        });
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).disposition, "settled");
      }),
    ),
  );

  it.effect("with BIGBUD_SLEEP_CONTINUATION=0, classifies and prompts but never sends", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        yield* cutAtWake(h);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.reason, "interrupted-by-sleep");
      }),
    ),
  );

  it.effect("keeps a failure outside any sleep window on today's path", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500, "rate limited"));
        h.advance(60_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "none");
      }),
    ),
  );
});
