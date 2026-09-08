import { CommandId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeCommandOutcomeQuery } from "./OrchestrationEngine.commandOutcome.ts";

function makeQuery(
  receipt: Parameters<OrchestrationCommandReceiptRepositoryShape["upsert"]>[0] | null,
) {
  return makeCommandOutcomeQuery({
    serverEpoch: "server-epoch",
    canonicalRevision: () => 7,
    receipts: {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(receipt === null ? Option.none() : Option.some(receipt)),
      claimOrInspect: () => Effect.succeed({ status: "claimed" }),
    },
  });
}

it.effect("returns a safe accepted command outcome from its durable receipt", () =>
  Effect.gen(function* () {
    const commandId = CommandId.makeUnsafe("command-accepted");
    const outcome = yield* makeQuery({
      commandId,
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      acceptedAt: "2026-08-26T12:00:00.000Z",
      resultSequence: 11,
      status: "accepted",
      rejectionReason: null,
      error: "internal detail must not cross the RPC boundary",
      payloadDigestVersion: null,
      payloadDigest: null,
    })(commandId);

    assert.deepStrictEqual(outcome, {
      commandId,
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      acceptedAt: "2026-08-26T12:00:00.000Z",
      resultSequence: 11,
      status: "accepted",
      serverEpoch: "server-epoch",
      canonicalRevision: 11,
    });
    assert.isFalse("error" in outcome);
  }),
);

it.effect("returns a typed duplicate-create rejection without raw receipt details", () =>
  Effect.gen(function* () {
    const commandId = CommandId.makeUnsafe("command-duplicate");
    const outcome = yield* makeQuery({
      commandId,
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      acceptedAt: "2026-08-26T12:01:00.000Z",
      resultSequence: 11,
      status: "rejected",
      rejectionReason: "thread_already_exists",
      error: "private duplicate detail",
      payloadDigestVersion: null,
      payloadDigest: null,
    })(commandId);

    assert.deepStrictEqual(outcome, {
      commandId,
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      rejectedAt: "2026-08-26T12:01:00.000Z",
      reason: "thread_already_exists",
      resultSequence: 11,
      status: "rejected",
      serverEpoch: "server-epoch",
      canonicalRevision: 11,
    });
    assert.isFalse("error" in outcome);
  }),
);

it.effect("returns other for typed non-duplicate rejections", () =>
  Effect.gen(function* () {
    const commandId = CommandId.makeUnsafe("command-other-rejection");
    const outcome = yield* makeQuery({
      commandId,
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      acceptedAt: "2026-08-26T12:02:00.000Z",
      resultSequence: 7,
      status: "rejected",
      rejectionReason: "other",
      error: "private invariant detail",
      payloadDigestVersion: null,
      payloadDigest: null,
    })(commandId);

    assert.strictEqual(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.strictEqual(outcome.reason, "other");
    assert.isFalse("error" in outcome);
  }),
);

it.effect("classifies legacy rejected receipts without a typed reason as other", () =>
  Effect.gen(function* () {
    const commandId = CommandId.makeUnsafe("command-legacy-rejection");
    const outcome = yield* makeQuery({
      commandId,
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      acceptedAt: "2026-08-26T12:03:00.000Z",
      resultSequence: 7,
      status: "rejected",
      rejectionReason: null,
      error: "legacy private detail",
      payloadDigestVersion: null,
      payloadDigest: null,
    })(commandId);

    assert.strictEqual(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.strictEqual(outcome.reason, "other");
  }),
);

it.effect("returns unknown when no durable command receipt exists", () =>
  Effect.gen(function* () {
    const commandId = CommandId.makeUnsafe("command-unknown");

    assert.deepStrictEqual(yield* makeQuery(null)(commandId), {
      commandId,
      status: "unknown",
      serverEpoch: "server-epoch",
      canonicalRevision: 7,
    });
  }),
);
