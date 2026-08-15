import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";
import {
  deriveThreadRetentionMaintenanceState,
  makeThreadRetentionPreview,
} from "./ThreadRetention.preview.ts";

const scheduled = { trigger: "scheduled" as const, status: "selecting" };
const manual = { trigger: "manual" as const, status: "purging" };

it("derives explicit retention preview maintenance states", () => {
  assert.equal(
    deriveThreadRetentionMaintenanceState({ purgeBacklog: 0, purgeBacklogLimit: 100 }),
    "available",
  );
  assert.equal(
    deriveThreadRetentionMaintenanceState({
      activeRun: scheduled,
      purgeBacklog: 0,
      purgeBacklogLimit: 100,
    }),
    "scheduled_active",
  );
  assert.equal(
    deriveThreadRetentionMaintenanceState({
      activeRun: manual,
      purgeBacklog: 0,
      purgeBacklogLimit: 100,
    }),
    "manual_active",
  );
  assert.equal(
    deriveThreadRetentionMaintenanceState({
      activeRun: { ...scheduled, status: "deferred" },
      purgeBacklog: 0,
      purgeBacklogLimit: 100,
    }),
    "safety_deferred",
  );
  assert.equal(
    deriveThreadRetentionMaintenanceState({ purgeBacklog: 100, purgeBacklogLimit: 100 }),
    "safety_deferred",
  );
});

it.effect("allows manual previews to choose any finite policy independently", () =>
  Effect.gen(function* () {
    const repository = {
      preview: () =>
        Effect.succeed({
          eligibleCount: 1,
          oldestEligibleActivityAt: "2026-01-01T00:00:00.000Z",
          newestEligibleActivityAt: "2026-01-02T00:00:00.000Z",
          exclusionCounts: [],
          estimatedAttachmentCount: 0,
          estimatedResourceCount: 0,
          estimatedKnownBytes: 0,
          attachmentEstimateComplete: true,
          resourceEstimateComplete: true,
          bytesEstimateComplete: true,
        }),
      issueChallenge: (input: {
        readonly challengeId: string;
        readonly trigger: "manual" | "policy-change";
        readonly policy: "7-days" | "14-days" | "30-days" | "90-days";
        readonly cutoffAt: string;
        readonly issuedAt: string;
        readonly expiresAt: string;
      }) => Effect.succeed({ ...input, token: "preview-token" }),
      listRecoverableRuns: () => Effect.succeed([]),
    } as unknown as ThreadRetentionRepositoryShape;
    const preview = makeThreadRetentionPreview({
      repository,
      purgeJobs: { countIncomplete: () => Effect.succeed(0) },
    });

    for (const policy of ["7-days", "90-days"] as const) {
      const result = yield* preview({ trigger: "manual", policy });
      assert.equal(result.policy, policy);
      assert.equal(result.challenge.policy, policy);
      assert.equal(result.challenge.cutoffAt, result.cutoffAt);
    }
  }),
);
