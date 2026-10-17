import { runV2Cleanup } from "./Client.guard.ts";
import {
  decodeV2EnrollmentRecord,
  type V2AnyEnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import {
  V2EnrollmentRetirement,
  type V2RetirementProof,
} from "./Orchestration.enrollment.retirement.ts";
import {
  validateV2LeaseInspection,
  validateV2DetachAcknowledgement,
} from "./Orchestration.enrollment.ack.ts";
import { digestV2EnrollmentOwner } from "./Orchestration.enrollment.record.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";

/** Exact cleanup is scoped to the original owner and one observer deadline. Aborting the
 * observer stops new operations; already issued RPCs stay tracked by enrollment controls. */
export async function detachV2Enrollment(
  input: {
    records: V2ThreadRecords;
    key: string;
    digest: string;
    owner: V2AnyEnrollmentOwner;
    transport: string;
    persistRevoked: () => Promise<void>;
    leases: () => Parameters<typeof validateV2LeaseInspection>[2];
    rpc: (method: "inspect" | "detach") => Promise<Parameters<typeof validateV2LeaseInspection>[0]>;
    retirementProof?: (signal?: AbortSignal) => Promise<V2RetirementProof>;
  },
  signal?: AbortSignal,
) {
  const check = () => signal?.throwIfAborted();
  return runV2Cleanup(
    input.transport,
    input.owner.nativeSessionId,
    async () => {
      check();
      const saved = await input.records.read(input.key);
      check();
      const retirement = await V2EnrollmentRetirement.open(input.records);
      check();
      const identity = {
        wireProtocol: input.owner.protocol,
        ownerDigest: digestV2EnrollmentOwner(input.owner),
        enrollmentNonce: input.owner.enrollmentNonce,
        directory: input.owner.directory,
        nativeSessionId: input.owner.nativeSessionId,
      };
      if (!saved || decodeV2EnrollmentRecord(saved.value).digest !== input.digest)
        throw new Error("V2 retirement exact owner evidence missing; successor preserved.");
      await retirement.begin(identity, saved);
      check();
      await input.persistRevoked();
      check();
      const inspected = await input.rpc("inspect");
      check();
      validateV2LeaseInspection(
        inspected,
        { digest: input.digest, nonce: input.owner.enrollmentNonce },
        input.leases(),
      );
      const ack = await input.rpc("detach");
      check();
      validateV2DetachAcknowledgement(
        ack,
        { digest: input.digest, nonce: input.owner.enrollmentNonce },
        inspected,
      );
      await retirement.acknowledge(
        identity,
        ack,
        inspected,
        "bootstrapDigest" in input.owner ? input.owner.bootstrapDigest : input.owner.artifactDigest,
        input.owner.transportGeneration,
      );
      check();
      if (!input.retirementProof) return false;
      const proof = await input.retirementProof(signal);
      check();
      return retirement.settleIfProved(identity, proof);
    },
    signal,
  );
}
