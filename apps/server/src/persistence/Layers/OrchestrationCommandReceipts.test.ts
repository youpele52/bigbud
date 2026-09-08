import { CommandId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationCommandReceiptRepository", (it) => {
  it.effect("never overwrites an accepted receipt with a later rejection", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const commandId = CommandId.makeUnsafe("command-accepted-receipt-protected");
      const aggregateId = ProjectId.makeUnsafe("project-accepted-receipt-protected");
      const payloadDigestVersion = "orchestration-command-payload/v1";
      const payloadDigest = "digest-accepted-receipt-protected";
      const accepted = {
        commandId,
        aggregateKind: "project" as const,
        aggregateId,
        acceptedAt: "2026-08-27T00:00:00.000Z",
        resultSequence: 7,
        status: "accepted" as const,
        rejectionReason: null,
        error: null,
        payloadDigestVersion,
        payloadDigest,
      };
      yield* repository.upsert(accepted);
      yield* repository.upsert({
        ...accepted,
        acceptedAt: "2026-08-27T00:01:00.000Z",
        resultSequence: 8,
        status: "rejected",
        rejectionReason: "other",
        error: "late invariant result",
        payloadDigestVersion,
        payloadDigest,
      });

      assert.deepStrictEqual(
        yield* repository.getByCommandId({ commandId }),
        Option.some(accepted),
      );
    }),
  );

  it.effect("atomically detects command id reuse with a different payload digest", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const commandId = CommandId.makeUnsafe("command-digest-conflict");
      const claimedAt = "2026-08-27T00:00:00.000Z";
      const first = yield* repository.claimOrInspect({
        commandId,
        payloadDigestVersion: "orchestration-command-payload/v1",
        payloadDigest: "digest-a",
        claimedAt,
      });
      const second = yield* repository.claimOrInspect({
        commandId,
        payloadDigestVersion: "orchestration-command-payload/v1",
        payloadDigest: "digest-b",
        claimedAt,
      });

      assert.deepStrictEqual(first, { status: "claimed" });
      assert.deepStrictEqual(second, {
        status: "conflict",
        storedPayloadDigestVersion: "orchestration-command-payload/v1",
        storedPayloadDigest: "digest-a",
      });
    }),
  );

  it.effect("does not bind a legacy receipt to an unverifiable retry payload", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const commandId = CommandId.makeUnsafe("command-legacy-unbound");
      yield* repository.upsert({
        commandId,
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-legacy-unbound"),
        acceptedAt: "2026-08-27T00:00:00.000Z",
        resultSequence: 3,
        status: "accepted",
        rejectionReason: null,
        error: null,
        payloadDigestVersion: null,
        payloadDigest: null,
      });

      const result = yield* repository.claimOrInspect({
        commandId,
        payloadDigestVersion: "orchestration-command-payload/v1",
        payloadDigest: "arbitrary-retry-digest",
        claimedAt: "2026-08-27T00:01:00.000Z",
      });

      assert.deepStrictEqual(result, {
        status: "conflict",
        storedPayloadDigestVersion: "legacy-unbound/v0",
        storedPayloadDigest: "unavailable",
      });
    }),
  );
});
