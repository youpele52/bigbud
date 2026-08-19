import { assert, it } from "@effect/vitest";

import type { PurgeJob, PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import {
  deduplicateLegacyPurgeResources,
  isRecoverableLegacyResource,
} from "./LegacyPurgeManifestRecovery.ts";

const resource: PurgeResource = {
  kind: "attachment",
  relativePath: "thread-1-00000000-0000-0000-0000-000000000001.png",
  identity: {
    declaredPath: "/tmp/attachments/thread-1-00000000-0000-0000-0000-000000000001.png",
    canonicalPath: "/tmp/attachments/thread-1-00000000-0000-0000-0000-000000000001.png",
    device: 1,
    inode: 2,
    changedAtMs: 3,
    type: "file",
    root: { canonicalPath: "/tmp/attachments", device: 1, inode: 1 },
    parent: { canonicalPath: "/tmp/attachments", device: 1, inode: 1 },
  },
  quarantineName: ".bigbud-purge-test",
  action: "delete",
};

const job = (jobId: string): PurgeJob => ({
  jobId,
  entityKind: "thread",
  entityId: "thread-1",
  phase: "files",
  status: "failed",
  resourceManifest: [resource],
  manifestDigest: null,
  manifestSealedAt: null,
  attemptCount: 0,
  lastError: "manual_recovery_required",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  completedAt: null,
});

it("deduplicates identical captured legacy resources while preserving linked jobs", () => {
  const groups = deduplicateLegacyPurgeResources([
    { job: job("legacy-a"), resource },
    { job: job("legacy-b"), resource: { ...resource } },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]!.map((candidate) => candidate.job.jobId),
    ["legacy-a", "legacy-b"],
  );
});

it("does not recover resources already marked as shared", () => {
  assert.isFalse(
    isRecoverableLegacyResource({
      job: job("legacy-shared"),
      resource: { ...resource, action: "retain-shared" },
    }),
  );
});
