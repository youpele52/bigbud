import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { MobileRecoveryBaselineError } from "@bigbud/contracts/server/mobile.recovery";
import { WsMobileRecoveryBaselineRpc } from "@bigbud/contracts/server/rpc.mobile.recovery.ts";
import { assert } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  MOBILE_BASELINE_MAX_BYTES,
  MOBILE_BASELINE_TOO_LARGE_MESSAGE,
  MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH,
} from "../../mobile/mobileRecordBounds.ts";
import { serializedBytes } from "../../ws/wsMobileRecovery.frames.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionMobileRecoveryBaseline,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  insertActivities,
  insertMessages,
  insertPendingApproval,
  insertProject,
  insertThread,
  publishProjectionState,
} from "./ProjectionSnapshotQuery.mobile.bounds.fixtures.ts";
import { projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

const KB = 1024;
const GATEWAY_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const encodeBaselineExit = Schema.encodeUnknownSync(
  Schema.toCodecJson(Rpc.exitSchema(WsMobileRecoveryBaselineRpc)),
);

const measure = (baseline: ProjectionMobileRecoveryBaseline) =>
  serializedBytes({
    snapshot: baseline.snapshot,
    snapshotSequence: baseline.snapshotSequence,
    selectedThread: baseline.selectedThread,
  });

/** The baseline as the mobile RPC writes it to the socket: the JSON `Exit` success envelope. */
function envelopeBytes(baseline: ProjectionMobileRecoveryBaseline): number {
  const response = {
    version: 1,
    recoveryAttemptId: "mobile-budget-attempt",
    serverEpoch: "mobile-budget-server-epoch",
    snapshotSequence: baseline.snapshotSequence,
    snapshot: baseline.snapshot,
    selectedThread: baseline.selectedThread,
  };
  return serializedBytes({
    _tag: "Exit",
    requestId: String(Number.MAX_SAFE_INTEGER),
    exit: encodeBaselineExit(Exit.succeed(response)),
  });
}

/**
 * A selected thread at the detail text budget (40 × 12 KiB) plus `summaryThreads` active threads
 * of four `summaryMessageSize` messages each, all under the per-record threshold.
 */
const seedAggregate = Effect.fn("seedAggregate")(function* (input: {
  readonly fixture: string;
  readonly summaryThreads: number;
  readonly summaryMessageSize: number;
}) {
  const project = `mobile-budget-project-${input.fixture}`;
  const selected = `mobile-budget-selected-${input.fixture}`;
  yield* insertProject(project);
  yield* insertThread(project, selected);
  yield* insertMessages(
    selected,
    Array.from({ length: 40 }, (_, index) => `${index}`.padEnd(12 * KB, "s")),
  );
  for (let index = 1; index <= input.summaryThreads; index += 1) {
    const thread = `mobile-budget-summary-${index}-${input.fixture}`;
    yield* insertThread(project, thread);
    yield* insertMessages(
      thread,
      ["a", "b", "c", "d"].map((c) => c.repeat(input.summaryMessageSize)),
    );
  }
  yield* publishProjectionState(31);
  return { project, selected };
});

const getBaseline = Effect.fn("getBaseline")(function* (threadId: string) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  return yield* snapshotQuery.getMobileRecoveryBaseline!(ThreadId.makeUnsafe(threadId));
});

const selectedOf = (baseline: ProjectionMobileRecoveryBaseline) =>
  baseline.selectedThread?.status === "present" ? baseline.selectedThread : null;

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile.budget older history", (it) => {
  it.effect("drops older selected messages first when that alone fits the budget", () =>
    Effect.gen(function* () {
      const fixture = crypto.randomUUID();
      const { selected } = yield* seedAggregate({
        fixture,
        summaryThreads: 3,
        summaryMessageSize: 220 * KB,
      });

      const baseline = yield* getBaseline(selected);
      const thread = selectedOf(baseline);
      const kept = thread?.thread.messages ?? [];

      assert.isAtMost(measure(baseline), MOBILE_BASELINE_MAX_BYTES);
      // Close to the budget, the wire message still leaves about 1 MiB of gateway headroom.
      assert.isAtMost(envelopeBytes(baseline), MOBILE_BASELINE_MAX_BYTES + 512);
      assert.equal(thread?.hasOlderHistory, true);
      assert.isAbove(kept.length, 1);
      assert.isBelow(kept.length, 40);
      assert.isTrue(kept.at(-1)?.text.startsWith("39"));
      for (const summary of baseline.snapshot.threads.filter((entry) => entry.id !== selected)) {
        assert.deepEqual(
          summary.messages.map((message) => message.text.length),
          [220 * KB, 220 * KB, 220 * KB, 220 * KB],
        );
      }
    }),
  );
});

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile.budget previews", (it) => {
  it.effect("then previews summary messages, and the RPC envelope stays under 4 MiB", () =>
    Effect.gen(function* () {
      const fixture = crypto.randomUUID();
      const { selected } = yield* seedAggregate({
        fixture,
        summaryThreads: 4,
        summaryMessageSize: 200 * KB,
      });

      const baseline = yield* getBaseline(selected);
      const bodyBytes = measure(baseline);
      const wireBytes = envelopeBytes(baseline);
      const summaryTexts = baseline.snapshot.threads.flatMap((thread) =>
        thread.messages.map((message) => message.text),
      );

      assert.isAtMost(bodyBytes, MOBILE_BASELINE_MAX_BYTES);
      assert.deepEqual(
        selectedOf(baseline)?.thread.messages.map((message) => message.text.slice(0, 2)),
        ["39"],
      );
      assert.equal(selectedOf(baseline)?.hasOlderHistory, true);
      assert.equal(summaryTexts.length, 20);
      for (const text of summaryTexts) {
        assert.isAtMost(text.length, MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH + 128);
        assert.include(text, "Open it on the desktop to read all of it.");
      }
      assert.isTrue(summaryTexts.some((text) => text.includes("(200 KB)")));
      assert.isAtMost(wireBytes, GATEWAY_MAX_MESSAGE_BYTES);
      // The envelope adds only fixed framing on top of the measured body.
      assert.isBelow(wireBytes - bodyBytes, 512);
    }),
  );
});

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile.budget failure", (it) => {
  it.effect("fails with the typed baseline error when degrading cannot fit the budget", () =>
    Effect.gen(function* () {
      const fixture = crypto.randomUUID();
      const project = `mobile-budget-project-${fixture}`;
      const selected = `mobile-budget-pending-${fixture}`;
      const requestId = `${selected}-request`;
      yield* insertProject(project);
      yield* insertThread(project, selected);
      yield* insertPendingApproval(selected, requestId);
      yield* insertActivities(selected, [
        {
          id: `${selected}-approval`,
          kind: "approval.requested",
          sequence: 1,
          // Pending approvals are never cut or dropped, so this alone exceeds the budget.
          payload: JSON.stringify({ requestId, diff: "d".repeat(3.5 * 1024 * KB) }),
        },
      ]);
      yield* publishProjectionState(32);

      const error = yield* Effect.flip(getBaseline(selected));

      assert.equal(error._tag, "PersistenceSqlError");
      assert.equal(
        error._tag === "PersistenceSqlError" ? error.detail : null,
        MOBILE_BASELINE_TOO_LARGE_MESSAGE,
      );
      assert.instanceOf(error.cause, MobileRecoveryBaselineError);
      assert.equal(
        (error.cause as MobileRecoveryBaselineError).message,
        "Too much recent activity to load on mobile. Open it on the desktop.",
      );
    }),
  );
});
