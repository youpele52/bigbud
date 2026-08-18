import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";
import {
  deriveThreadRetentionMaintenanceState,
  makeThreadRetentionPreview,
} from "./ThreadRetention.preview.ts";

it("reports immediate cleanup availability", () => {
  assert.equal(deriveThreadRetentionMaintenanceState(), "available");
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
    } as unknown as ThreadRetentionRepositoryShape;
    const preview = makeThreadRetentionPreview({
      repository,
    });

    for (const policy of ["7-days", "90-days"] as const) {
      const result = yield* preview({ trigger: "manual", policy });
      assert.equal(result.policy, policy);
      assert.equal(result.challenge.policy, policy);
      assert.equal(result.challenge.cutoffAt, result.cutoffAt);
    }
  }),
);
