import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ThreadMetadataGenerationRepository,
  type MetadataGenerationAttempt,
  type MetadataGenerationJob,
} from "../Services/ThreadMetadataGeneration.ts";
import { ThreadMetadataGenerationRepositoryLive } from "./ThreadMetadataGeneration.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = ThreadMetadataGenerationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const at = (minute: number) => `2026-11-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
const jobInput = (id: string): Omit<MetadataGenerationJob, "revision" | "state"> => ({
  jobId: id,
  threadId: ThreadId.makeUnsafe(id),
  operation: "title",
  generationKey: "initial",
  configEpoch: "config-1",
  contextJson: JSON.stringify({ configuredPrimary: true }),
  expectedRevision: 0,
  sourceFrontier: 1,
  workspaceFingerprint: "workspace-1",
  createdAt: at(0),
  deadlineAt: at(30),
  modelWaitUntil: at(1),
  nativeWaitUntil: at(10),
  nextAttemptAt: at(0),
});
const attemptInput = (
  job: MetadataGenerationJob,
  ordinal = 1,
): Omit<MetadataGenerationAttempt, "state" | "result" | "dispatchedAt" | "revision"> => ({
  attemptId: `${job.jobId}:${ordinal}`,
  jobId: job.jobId,
  threadId: job.threadId,
  stage: "primary",
  ordinal,
  owner: `owner:${ordinal}`,
  executionFingerprint: "path",
  payloadJson: JSON.stringify({ commandId: "immutable", createdAt: at(0) }),
  providerSessionId: null,
  providerTurnId: null,
  sessionEpoch: null,
  createdAt: at(0),
  updatedAt: at(0),
});
const prepare = (job: MetadataGenerationJob, ordinal = 1) =>
  Effect.gen(function* () {
    const repository = yield* ThreadMetadataGenerationRepository;
    return Option.getOrThrow(
      yield* repository.prepareAttempt({ job, attempt: attemptInput(job, ordinal) }),
    );
  });

it.layer(layer)("durable metadata recovery", (it) => {
  it.effect("coalesces concurrent triggers and preserves the first captured context", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const input = jobInput("coalesce");
      const [first, second] = yield* Effect.all(
        [
          r.createOrGet(input),
          r.createOrGet({ ...input, jobId: "replacement", contextJson: "{}" }),
        ],
        { concurrency: 2 },
      );
      assert.strictEqual(first.jobId, second.jobId);
      assert.strictEqual(first.contextJson, second.contextJson);
      const changed = yield* r.createOrGet({
        ...input,
        jobId: "new-config",
        generationKey: "manual-retry",
        configEpoch: "config-2",
      });
      assert.strictEqual(changed.jobId, first.jobId);
    }),
  );

  it.effect(
    "retains owner and payload and lets exactly one dispatcher cross the durable fence",
    () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const job = yield* r.createOrGet(jobInput("claim"));
        const original = yield* prepare(job);
        const duplicate = Option.getOrThrow(
          yield* r.prepareAttempt({
            job,
            attempt: {
              ...attemptInput(job),
              attemptId: "wrong-id",
              owner: "replacement-owner",
              payloadJson: "{}",
            },
          }),
        );
        assert.deepStrictEqual(duplicate, original);
        const claims = yield* Effect.all(
          [r.claimDispatch(original, at(1)), r.claimDispatch(original, at(1))],
          { concurrency: 2 },
        );
        assert.strictEqual(claims.filter(Boolean).length, 1);
        const stored = (yield* r.listAttempts(job.jobId))[0]!;
        assert.strictEqual(stored.state, "dispatch-intent");
        assert.strictEqual(stored.owner, original.owner);
        assert.strictEqual(stored.payloadJson, original.payloadJson);
        assert.isFalse(yield* r.settleAttempt({ attempt: original, state: "failed", at: at(2) }));
        assert.isFalse(
          yield* r.settleAttempt({
            attempt: { ...stored, owner: "intruder" },
            state: "failed",
            at: at(2),
          }),
        );
      }),
  );

  it.effect("deadlines, cancellation, and settings changes cannot erase uncertain dispatch", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const job = yield* r.createOrGet(jobInput("uncertain"));
      const a = yield* prepare(job);
      yield* r.claimDispatch(a, at(1));
      assert.isFalse(
        yield* r.transitionJob({
          jobId: job.jobId,
          expectedRevision: job.revision,
          state: "cancelled",
          nextAttemptAt: at(40),
        }),
      );
      assert.isTrue(Option.isNone(yield* r.prepareAttempt({ job, attempt: attemptInput(job, 2) })));
      const replacement = yield* r.createOrGet({
        ...jobInput("uncertain"),
        jobId: "reset",
        generationKey: "reset",
        configEpoch: "new-config",
      });
      assert.strictEqual(replacement.jobId, job.jobId);
      assert.strictEqual(
        (yield* r.listDue({ at: at(40), limit: 10 })).some((j) => j.jobId === job.jobId),
        true,
      );
    }),
  );

  it.effect("retains generated results across failed persistence and prevents regeneration", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const job = yield* r.createOrGet(jobInput("result"));
      const prepared = yield* prepare(job);
      yield* r.claimDispatch(prepared, at(1));
      const sent = (yield* r.listAttempts(job.jobId))[0]!;
      assert.isTrue(
        yield* r.settleAttempt({
          attempt: sent,
          state: "result-ready",
          result: "A useful title",
          at: at(2),
        }),
      );
      const result = (yield* r.listAttempts(job.jobId))[0]!;
      assert.strictEqual(result.result, "A useful title");
      assert.isFalse(yield* r.settleAttempt({ attempt: result, state: "failed", at: at(3) }));
      assert.isFalse(
        yield* r.transitionJob({
          jobId: job.jobId,
          expectedRevision: job.revision,
          state: "exhausted",
          nextAttemptAt: at(40),
        }),
      );
      assert.isTrue(Option.isNone(yield* r.prepareAttempt({ job, attempt: attemptInput(job, 2) })));
      assert.isTrue(yield* r.settleAttempt({ attempt: result, state: "completed", at: at(3) }));
      assert.isTrue(
        yield* r.transitionJob({
          jobId: job.jobId,
          expectedRevision: job.revision,
          state: "completed",
          nextAttemptAt: at(3),
        }),
      );
      const replay = yield* r.createOrGet(jobInput("result"));
      assert.strictEqual(replay.state, "completed");
      assert.strictEqual((yield* r.listAttempts(job.jobId))[0]!.result, "A useful title");
    }),
  );

  it.effect("advances only claimed summary frontiers and never moves them backwards", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const title = yield* r.createOrGet(jobInput("frontier"));
      yield* r.claimDispatch(yield* prepare(title), at(1));
      assert.strictEqual((yield* r.readMetadataState(title.threadId)).summaryAttemptedFrontier, 0);
      for (const frontier of [15, 5, 25]) {
        const job = yield* r.createOrGet({
          ...jobInput("frontier"),
          jobId: `summary-frontier-${frontier}`,
          generationKey: `frontier-${frontier}`,
          operation: "summary",
          sourceFrontier: frontier,
        });
        const a = yield* prepare(job);
        assert.isFalse(yield* r.claimDispatch({ ...a, owner: "wrong-owner" }, at(1)));
        assert.strictEqual(
          (yield* r.readMetadataState(job.threadId)).summaryAttemptedFrontier,
          frontier === 15 ? 0 : 15,
        );
        const claims = yield* Effect.all([r.claimDispatch(a, at(1)), r.claimDispatch(a, at(1))], {
          concurrency: 2,
        });
        assert.strictEqual(claims.filter(Boolean).length, 1);
        assert.strictEqual(
          (yield* r.readMetadataState(job.threadId)).summaryAttemptedFrontier,
          Math.max(frontier, 15),
        );
        const sent = (yield* r.listAttempts(job.jobId))[0]!;
        yield* r.settleAttempt({ attempt: sent, state: "failed", at: at(2) });
        assert.isTrue(
          yield* r.transitionJob({
            jobId: job.jobId,
            expectedRevision: job.revision,
            state: "exhausted",
            nextAttemptAt: at(2),
          }),
        );
      }
    }),
  );

  it.effect("rolls back dispatch intent when the summary frontier cannot be persisted", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const sql = yield* SqlClient.SqlClient;
      const job = yield* r.createOrGet({ ...jobInput("frontier-rollback"), operation: "summary" });
      const a = yield* prepare(job);
      yield* sql`CREATE TEMP TRIGGER reject_metadata_frontier BEFORE INSERT
        ON thread_metadata_generation_state BEGIN SELECT RAISE(ABORT, 'test frontier failure'); END`;
      const outcome = yield* r.claimDispatch(a, at(1)).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.deepStrictEqual((yield* r.listAttempts(job.jobId))[0], a);
      assert.strictEqual((yield* r.readMetadataState(job.threadId)).summaryAttemptedFrontier, 0);
      yield* sql`DROP TRIGGER reject_metadata_frontier`;
      assert.isTrue(yield* r.claimDispatch(a, at(1)));
      assert.strictEqual((yield* r.readMetadataState(job.threadId)).summaryAttemptedFrontier, 1);
    }),
  );

  it.effect("refuses new native attempts for both title and summary", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
      const title = yield* r.createOrGet(jobInput("native"));
      const summary = yield* r.createOrGet({
        ...jobInput("native"),
        jobId: "native-summary",
        operation: "summary",
      });
      const titleAttempt = { ...attemptInput(title), stage: "native" as const };
      const first = yield* r.prepareAttempt({ job: title, attempt: titleAttempt });
      assert.isTrue(Option.isNone(first));
      const second = yield* r.prepareAttempt({
        job: summary,
        attempt: { ...attemptInput(summary), stage: "native" },
      });
      assert.isTrue(Option.isNone(second));
    }),
  );

  it.effect(
    "rejects stale job revisions and retains metadata revisions independently of activity tails",
    () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const job = yield* r.createOrGet(jobInput("revisions"));
        assert.isTrue(
          yield* r.transitionJob({
            jobId: job.jobId,
            expectedRevision: 0,
            state: "waiting-model",
            nextAttemptAt: at(1),
          }),
        );
        assert.isFalse(
          yield* r.transitionJob({
            jobId: job.jobId,
            expectedRevision: 0,
            state: "cancelled",
            nextAttemptAt: at(1),
          }),
        );
        assert.isTrue(Option.isNone(yield* r.prepareAttempt({ job, attempt: attemptInput(job) })));
        yield* r.advanceMetadataRevision(job.threadId, "title");
        yield* r.advanceMetadataRevision(job.threadId, "summary");
        yield* r.recordSuccessfulModel(job.threadId, '{"provider":"codex","model":"verified"}');
        const state = yield* r.readMetadataState(job.threadId);
        assert.strictEqual(state.titleRevision, 1);
        assert.strictEqual(state.summaryRevision, 1);
        assert.strictEqual(state.successfulModelJson, '{"provider":"codex","model":"verified"}');
      }),
  );

  it.effect(
    "requires two actual primary failures for a warning and deduplicates by config epoch",
    () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const job = yield* r.createOrGet(jobInput("warning"));
        const warning = { jobId: job.jobId, warningId: "warning-1", at: at(3) };
        for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
          assert.isFalse(yield* r.enqueueWarning(warning));
          const a = yield* prepare(job, ordinal);
          yield* r.claimDispatch(a, at(1));
          const sent = (yield* r.listAttempts(job.jobId)).find(
            (entry) => entry.ordinal === ordinal,
          )!;
          assert.isTrue(yield* r.settleAttempt({ attempt: sent, state: "failed", at: at(2) }));
        }
        assert.isTrue(yield* r.enqueueWarning(warning));
        assert.isFalse(yield* r.enqueueWarning({ ...warning, warningId: "duplicate" }));
        const pending = yield* r.listPendingWarnings(100);
        assert.strictEqual(pending.filter((w) => w.id === warning.warningId).length, 1);
        assert.isTrue(
          yield* r.claimWarning({
            warningId: warning.warningId,
            clientId: "main",
            at: at(3),
            until: at(4),
          }),
        );
        assert.isFalse(
          yield* r.claimWarning({
            warningId: warning.warningId,
            clientId: "compact",
            at: at(3),
            until: at(4),
          }),
        );
        assert.isFalse(
          yield* r.acknowledgeWarning({
            warningId: warning.warningId,
            clientId: "compact",
            at: at(3),
          }),
        );
        assert.isTrue(
          yield* r.acknowledgeWarning({
            warningId: warning.warningId,
            clientId: "main",
            at: at(3),
          }),
        );
        assert.isFalse((yield* r.listPendingWarnings(100)).some((w) => w.id === warning.warningId));
      }),
  );
});
