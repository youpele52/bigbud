import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import type { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { readV2NativeActivity } from "./PluginSetup.activity.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";

/** Known local/foreign physical evidence plus bounded native reads; never a global atomic-idle claim. */
export async function readV2ActivationIdle(
  job: V2OwnedActivationJob,
  proposal: {
    readonly artifact: V2PluginSetupArtifact;
    readonly directories: Set<string>;
    readonly scope: {
      readonly gate: V2ActivationGate;
      readonly participants: ReadonlyMap<string, { busyCount: () => number }>;
    };
  },
  signal: AbortSignal = job.signal,
) {
  signal.throwIfAborted();
  job.assertCurrent();
  if (
    proposal.scope.gate.busyCount() ||
    [...proposal.scope.participants.values()].some((owner) => owner.busyCount())
  )
    return false;
  const records = await V2ThreadRecords.open(
    proposal.artifact.root,
    "enrollments",
    proposal.artifact.privateKey,
    proposal.artifact.publicKey,
  );
  const retirements = await V2EnrollmentRetirement.open(records);
  for (const signed of await records.entries()) {
    signal.throwIfAborted();
    const value = decodeV2EnrollmentRecord(signed.value);
    job.assertCurrent();
    if (digestV2EnrollmentOwner(value.owner) !== value.digest)
      throw new Error("V2 invalid signed enrollment activity; no idle inference.");
    if (proposal.scope.participants.has(value.digest)) continue;
    try {
      await retirements.assertSettled({
        wireProtocol: value.owner.protocol,
        ownerDigest: value.digest,
        enrollmentNonce: value.owner.enrollmentNonce,
        directory: value.owner.directory,
        nativeSessionId: value.owner.nativeSessionId,
      });
    } catch {
      return false;
    } // Foreign/live/pending/uncertain owners defer even after lease expiry.
  }
  const native = await readV2NativeActivity(
    job.connection.client,
    () => {
      job.assertCurrent();
      signal.throwIfAborted();
    },
    signal,
  );
  for (const directory of native.directories) {
    if (!proposal.directories.has(directory) && proposal.directories.size >= 64)
      throw new Error("V2 activation known Location union exceeds its bound; no idle inference.");
    proposal.directories.add(directory);
  }
  return native.foregroundCount === 0 && native.runningShellCount === 0;
}
