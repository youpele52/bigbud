import { randomBytes } from "node:crypto";
import { V2ThreadEnrollment } from "./Orchestration.enrollment.ts";
import { V2_ENROLLMENT_PROTOCOL, type V2ThreadOwner } from "./Orchestration.protocol.ts";
import {
  V2_COMPATIBILITY_DIGEST,
  type V2BootstrapCompatibility,
  assertV2ImplementationCompatible,
} from "./Orchestration.compatibility.ts";
import { decodeV2ThreadCallback } from "./Orchestration.callback.ts";
import { V2ThreadApprovals } from "./Orchestration.approval.ts";
import { assertV2ThreadPolicy } from "./Orchestration.admission.ts";
import { V2ActiveExecutions } from "./Execution.owners.ts";
import { V2ThreadImplementationRegistry } from "./Orchestration.implementation.ts";
import type { V2ThreadImplementation } from "./Orchestration.implementation.types.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import { invokeV2ThreadOwner } from "./Orchestration.bridge.invoke.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import type { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import type { ProviderApprovalDecision } from "@bigbud/contracts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { Effect } from "effect";
import {
  v2BridgeRetirementProof,
  reconcileV2BridgeExecutions,
  registerV2BridgeActivation,
} from "./Orchestration.bridge.activation.ts";
import type { V2DeadBackendContext } from "./Orchestration.enrollment.deadBackend.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { settleWithinShutdown } from "./Runtime.shutdown.ts";

export interface Owner {
  readonly runtime: OpencodeV2Runtime;
  readonly session: V2RuntimeSession;
  readonly enrollment: V2ThreadEnrollment;
  readonly approvals: V2ThreadApprovals;
  readonly active: V2ActiveExecutions;
  readonly timer: ReturnType<typeof setInterval>;
  readonly implementation: V2ThreadImplementation;
  readonly releaseImplementation: () => void;
  unregisterActivation?: (() => void) | undefined;
  releaseListener?: (() => void) | undefined;
  retired?: boolean;
  readonly setupInstanceId?: string | undefined;
  readonly nativeProof?: V2NativeRuntimeProof;
  cancelledTurn?: string | undefined;
}
export interface V2ThreadBridgeOptions {
  readonly artifact: {
    readonly issuer: string;
    readonly artifactDigest: string;
    readonly privateKey: string;
  };
  readonly records: V2ThreadRecords;
  readonly receipts: V2ThreadReceipts;
  readonly callbackUrl: string;
  readonly preflight: (session: V2RuntimeSession) => Promise<void | {
    bootstrapDigest: string;
    bootstrapAbi: string;
    compatibilityDigest: string;
    compatibility: V2BootstrapCompatibility;
    nativeProof?: V2NativeRuntimeProof;
  }>;
  readonly implementations?: V2ThreadImplementationRegistry;
  readonly selectImplementation?: () => Promise<V2ThreadImplementation>;
  readonly deadBackend?: (
    client: OpencodeV2Client,
    transport: string | undefined,
  ) => V2DeadBackendContext | undefined;
  readonly recordOwner?: (digest: string, enrollmentNonce: string) => Promise<void>;
}

/** Narrow canonical authority only. No file/shell/native-fork operations enter this shared bridge. */
export class V2ThreadBridge {
  private readonly owners = new Map<string, Owner>();
  private readonly implementations: V2ThreadImplementationRegistry;
  constructor(private readonly options: V2ThreadBridgeOptions) {
    this.implementations = options.implementations ?? new V2ThreadImplementationRegistry();
  }

  async attach(session: V2RuntimeSession, runtime: OpencodeV2Runtime) {
    if (!session.localTools) return; // Deliberately hidden tool-disabled work never gets caller capability.
    const shared = runtime.options.config.sharedService;
    if (
      !shared ||
      !session.resources?.orchestration ||
      !session.consentPermit ||
      !session.sharedTransport
    )
      throw new Error("Required V2 canonical foreground resources missing.");
    if (session.row && session.row.namespace !== "foreground")
      throw new Error("V2 hidden history cannot enroll.");
    if (session.native.parentID || session.native.fork)
      throw new Error("V2 native child cannot impersonate canonical owner.");
    assertV2ThreadPolicy(session);
    const verified = await this.options.preflight(session);
    const assertCurrent = () => {
      verified?.nativeProof?.assertCurrent();
      session.consentPermit!.assertCurrent();
      if (
        runtime.sessions.get(session.threadId) !== session ||
        session.stopped ||
        session.executionBlocked ||
        !session.lease.process.isRunning() ||
        session.epoch !== (session.session.sessionEpoch ?? 0)
      )
        throw new Error("V2 canonical enrollment owner changed.");
    };
    if (this.owners.has(session.native.id))
      throw new Error("V2 canonical enrollment already owned.");
    const selected =
      (await this.options.selectImplementation?.()) ?? this.implementations.current();
    assertCurrent();
    if (this.owners.has(session.native.id))
      throw new Error(
        "V2 canonical enrollment acquired by another attach while verifying selection.",
      );
    assertV2ImplementationCompatible(selected, verified?.compatibility);
    const pinned = this.implementations.acquire(selected);
    const material: V2ThreadOwner = {
      protocol: V2_ENROLLMENT_PROTOCOL,
      issuer: this.options.artifact.issuer,
      bootstrapDigest:
        verified?.bootstrapDigest ??
        session.activation?.stamp.bootstrapDigest ??
        this.options.artifact.artifactDigest,
      bootstrapAbi: verified?.bootstrapAbi ?? pinned.handler.bootstrapAbi,
      implementationDigest: pinned.handler.implementationDigest,
      compatibilityDigest: verified?.compatibilityDigest ?? V2_COMPATIBILITY_DIGEST,
      threadId: session.threadId,
      nativeSessionId: session.native.id,
      storageIdentity: session.storageIdentity,
      directory: session.native.location.directory,
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      sessionEpoch: session.epoch,
      transportGeneration: shared.generation,
      consentRevision: session.consentPermit.revision,
      enrollmentNonce: randomBytes(16).toString("hex"),
      callbackToken: randomBytes(32).toString("hex"),
      callbackUrl: this.options.callbackUrl,
    };
    const active = new V2ActiveExecutions();
    const enrollment: V2ThreadEnrollment = new V2ThreadEnrollment({
      owner: material,
      records: this.options.records,
      privateKey: this.options.artifact.privateKey,
      client: session.lease.process.client,
      transport: session.sharedTransport,
      assertCurrent,
      deadBackend: this.options.deadBackend?.(
        session.lease.process.client,
        session.sharedTransport,
      ),
      recordOwner: this.options.recordOwner,
      retirementProof: (signal) =>
        v2BridgeRetirementProof(
          runtime,
          session,
          active,
          this.options.receipts,
          enrollment.controlCount() === 0,
          signal,
        ),
    });
    const approvals = new V2ThreadApprovals(runtime, session);
    const timer = setInterval(() => {
      if (enrollment.renewalPaused()) return;
      void runtime.authorized(() => enrollment.ensure()).catch(() => {});
    }, 20000);
    timer.unref();
    const owner: Owner = {
      runtime,
      session,
      enrollment,
      approvals,
      active,
      timer,
      implementation: pinned.handler,
      releaseImplementation: pinned.release,
      setupInstanceId: session.activation?.stamp.setupInstanceId,
      ...(verified?.nativeProof ? { nativeProof: verified.nativeProof } : {}),
    };
    this.owners.set(session.native.id, owner);
    owner.unregisterActivation = registerV2BridgeActivation(
      runtime,
      session,
      enrollment,
      active,
      timer,
      () => {
        owner.retired = true;
      },
    );
    const revoke = () => {
      session.threadToolsReady = false;
      enrollment.revoke();
      approvals.cancel();
      clearInterval(timer);
      void owner.active.cancel();
    };
    session.coding = {
      pending: () => approvals.events(),
      busyCount: () => owner.active.busyCount() + enrollment.controlCount(),
      reconcile: () =>
        reconcileV2BridgeExecutions(runtime, session, owner.active, this.options.receipts),
      revoke,
      cancelActive: () => {
        owner.cancelledTurn = session.row?.turnId;
        approvals.cancel();
        return owner.active.cancel();
      },
    };
    const abort = () => revoke();
    session.consentPermit.signal.addEventListener("abort", abort, { once: true });
    owner.releaseListener = () => session.consentPermit!.signal.removeEventListener("abort", abort);
    const retire = async (signal?: AbortSignal) => {
      revoke();
      await owner.active.cancel();
      session.consentPermit!.signal.removeEventListener("abort", abort);
      const settled = await enrollment.detach(signal);
      if (settled) {
        owner.unregisterActivation?.();
        if (this.owners.get(session.native.id) === owner) this.owners.delete(session.native.id);
        owner.releaseImplementation();
      }
    };
    // Shutdown passes a bound: a miss or failure leaves signed records for dead-backend recovery.
    session.resources.onThreadToolsCleanup = (signal) =>
      signal ? settleWithinShutdown(retire(signal), signal) : retire();
    try {
      await enrollment.start();
      session.threadToolsReady = true;
    } catch (error) {
      revoke();
      throw error;
    }
  }

  async ensure(session: V2RuntimeSession) {
    if (!session.localTools) return;
    const owner = this.owners.get(session.native.id);
    if (!owner || owner.session !== session)
      throw new Error("Required V2 thread-tools owner unavailable.");
    await this.options.preflight(session);
    if (
      owner.setupInstanceId &&
      owner.setupInstanceId !== session.activation?.stamp.setupInstanceId &&
      !owner.retired
    ) {
      session.threadToolsReady = false;
      clearInterval(owner.timer);
      owner.enrollment.revoke();
      owner.approvals.cancel();
      await owner.active.cancel();
      if (!(await owner.enrollment.detach()))
        throw new Error(
          "V2 native bootstrap lifetime was replaced; old physical evidence remains unconfirmed, no reenrollment or resend.",
        );
      owner.retired = true;
    }
    if (owner.retired) {
      owner.releaseListener?.();
      owner.unregisterActivation?.();
      this.owners.delete(session.native.id);
      owner.releaseImplementation();
      await this.attach(session, owner.runtime);
      return;
    }
    await owner.enrollment.ensure();
    await session.resources?.renewCanonicalAuth?.();
    session.threadToolsReady = true;
  }

  async callback(token: string, value: unknown, signal: AbortSignal) {
    const request = decodeV2ThreadCallback(value);
    const owner = [...this.owners.values()].find((item) =>
      item.enrollment.matches(token, request.ownerDigest, request.enrollmentNonce),
    );
    if (!owner) throw new Error("V2 thread-tools callback owner rejected.");
    const bounded = AbortSignal.any([
      signal,
      owner.enrollment.controller.signal,
      AbortSignal.timeout(request.kind === "invoke" ? 300000 : 5000),
    ]);
    bounded.throwIfAborted();
    if (request.kind === "proof") {
      if (request.leaseRevision !== request.revision || request.leaseExpiresAt !== request.expiry)
        throw new Error("V2 callback proof lease mismatch.");
      return runWithAbortableDeadline({
        operation: "V2 callback owner proof",
        timeoutMs: 5000,
        signal: bounded,
        run: (proofSignal) =>
          owner.runtime.authorized(async () => {
            await Effect.runPromise(
              owner.runtime.options.journal.assertOwnerAvailable(owner.session.threadId),
            );
            const validate = await v2ReplyGuard(
              owner.runtime.options,
              owner.runtime.sessions,
              owner.session,
              proofSignal,
            )();
            proofSignal.throwIfAborted();
            validate();
            return owner.enrollment.proof(request.revision, request.expiry, request.challenge);
          }),
      });
    }
    owner.enrollment.assertCallbackLease(request.leaseRevision, request.leaseExpiresAt);
    if (request.kind === "status")
      return runWithAbortableDeadline({
        operation: "V2 thread-tools owner status",
        timeoutMs: 5000,
        signal: bounded,
        run: () =>
          owner.runtime.authorized(async () => {
            await Effect.runPromise(
              owner.runtime.options.journal.assertOwnerAvailable(owner.session.threadId),
            );
            const validate = await v2ReplyGuard(
              owner.runtime.options,
              owner.runtime.sessions,
              owner.session,
              bounded,
            )();
            bounded.throwIfAborted();
            validate();
            owner.enrollment.assertLive();
            await owner.session.resources?.renewCanonicalAuth?.();
            bounded.throwIfAborted();
            validate();
            owner.enrollment.assertLive();
            return { active: true };
          }),
      });
    owner.session.activation?.gate.assertOpen();
    const result = await owner.runtime.authorized(() =>
      invokeV2ThreadOwner(owner, request, bounded, this.implementations, this.options.receipts),
    );
    bounded.throwIfAborted();
    owner.enrollment.assertLive();
    return result;
  }

  responseLease(value: unknown) {
    const request = decodeV2ThreadCallback(value);
    const owner = [...this.owners.values()].find(
      (item) =>
        item.enrollment.digest === request.ownerDigest &&
        item.enrollment.options.owner.enrollmentNonce === request.enrollmentNonce,
    );
    if (!owner) throw new Error("V2 callback response owner unavailable.");
    if (request.kind === "proof") {
      owner.enrollment.assertPendingLease(request.leaseRevision, request.leaseExpiresAt);
      return { revision: request.leaseRevision, expiry: request.leaseExpiresAt };
    }
    return owner.enrollment.acknowledgedLease();
  }

  async reply(
    runtime: OpencodeV2Runtime,
    session: V2RuntimeSession,
    id: string,
    decision: ProviderApprovalDecision,
  ) {
    const owner = this.owners.get(session.native.id);
    if (!owner || owner.runtime !== runtime || owner.session !== session)
      throw new Error("V2 canonical approval owner lost.");
    owner.enrollment.assertLive();
    await owner.approvals.reply(id, decision);
  }
  close() {
    for (const owner of this.owners.values()) owner.session.coding?.revoke();
  }
}
