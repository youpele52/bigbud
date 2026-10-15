import { runV2Cleanup } from "./Client.guard.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
  type V2AnyEnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import type { V2ThreadOwner } from "./Orchestration.protocol.ts";
import {
  validateV2LeaseInspection,
  type V2EnrollmentAcknowledgement,
} from "./Orchestration.enrollment.ack.ts";
import {
  settleV2PreviousRetirement,
  type V2DeadBackendContext,
} from "./Orchestration.enrollment.deadBackend.ts";

/** A new broker cannot mutate history or detach an unfenced foreign owner to manufacture readiness.
 * Only a dead-backend context (this process holds the state-directory lock) may retire an owner
 * whose backend is provably dead and whose exact native session is inactive. */
export async function assertV2PreviousHistoryRetired(
  records: V2ThreadRecords,
  scope: { storageIdentity: string; nativeSessionId: string; threadId: string; directory: string },
  deadBackend?: V2DeadBackendContext,
) {
  const saved = await records.read(
    JSON.stringify([scope.storageIdentity, scope.nativeSessionId, scope.threadId]),
  );
  if (!saved) return;
  const previous = decodeV2EnrollmentRecord(saved.value),
    owner = previous.owner;
  if (
    digestV2EnrollmentOwner(owner) !== previous.digest ||
    owner.storageIdentity !== scope.storageIdentity ||
    owner.nativeSessionId !== scope.nativeSessionId ||
    owner.threadId !== scope.threadId ||
    owner.directory !== scope.directory
  )
    throw new Error("V2 previous canonical owner scope is unconfirmed; history remains unchanged.");
  await settleV2PreviousRetirement(
    records,
    saved,
    {
      wireProtocol: owner.protocol,
      ownerDigest: previous.digest,
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    },
    deadBackend,
  );
}

/** Fresh exact cleanup never creates authority to prove whether an old owner existed or physically exited. */
export async function recoverV2PreviousEnrollment(
  records: V2ThreadRecords,
  saved: NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>,
  current: V2ThreadOwner,
  transport: string,
  rpc: (
    operation: "inspect" | "detach",
    owner: V2AnyEnrollmentOwner,
  ) => Promise<V2EnrollmentAcknowledgement>,
  deadBackend?: V2DeadBackendContext,
) {
  const previous = decodeV2EnrollmentRecord(saved.value),
    owner = previous.owner;
  if (
    digestV2EnrollmentOwner(owner) !== previous.digest ||
    owner.threadId !== current.threadId ||
    owner.storageIdentity !== current.storageIdentity ||
    owner.nativeSessionId !== current.nativeSessionId ||
    owner.directory !== current.directory ||
    owner.issuer !== current.issuer
  )
    throw new Error("V2 thread-tools persisted owner mismatch; history retained.");
  const retirement = await V2EnrollmentRetirement.open(records),
    identity = {
      wireProtocol: owner.protocol,
      ownerDigest: previous.digest,
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
  if (previous.state !== "revoked") {
    await settleV2PreviousRetirement(records, saved, identity, deadBackend);
    return;
  }
  const phase = await retirement.begin(identity, saved);
  if (phase === "retiring" || phase === "detach-acknowledged")
    await runV2Cleanup(transport, owner.nativeSessionId, async () => {
      const inspected = await rpc("inspect", owner),
        reconciled = validateV2LeaseInspection(
          inspected,
          { digest: previous.digest, nonce: owner.enrollmentNonce },
          [previous.acknowledged, previous.pending],
        );
      const ack = await rpc("detach", owner);
      await retirement.acknowledge(
        identity,
        ack,
        reconciled,
        current.bootstrapDigest,
        current.transportGeneration,
      );
    });
  await settleV2PreviousRetirement(records, saved, identity, deadBackend);
}
