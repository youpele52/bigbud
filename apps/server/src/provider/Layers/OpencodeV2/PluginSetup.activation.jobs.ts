import { randomBytes } from "node:crypto";
import type { V2ConsentAuthority, V2ConsentPermit } from "./Application.consent.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { v2NativeProofMetadata } from "./NativeCompatibility.status.ts";
import { runDetachedV2Caller } from "./Runtime.caller.ts";
import {
  v2ReadinessSetupReason,
  type V2ReadinessFailure,
} from "./Orchestration.readiness.failure.ts";
import type { V2NativeRuntimeProof, V2NativeSemanticProfile } from "./NativeCompatibility.types.ts";

export type V2ActivationState =
  | "checking"
  | "prepared"
  | "waiting-for-idle"
  | "closing-gate"
  | "retiring"
  | "publishing"
  | "verifying"
  | "ready"
  | "blocked"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "deferred";
export interface V2ActivationJobScope {
  readonly readinessFailure?: V2ReadinessFailure;
  readonly root: string;
  readonly issuer: string;
  readonly registrationId?: string;
  readonly transport: string;
  readonly generation: string;
  readonly digest: string;
  readonly consentRevision: number;
  readonly descriptor: Parameters<typeof borrowV2SharedService>[0];
}
export interface V2ActivationHandle {
  readonly jobId: string;
  readonly interestId: string;
}
export interface V2ActivationJobStatus {
  readonly jobId: string;
  readonly state: V2ActivationState;
  readonly desiredDigest: string;
  readonly reason?: string;
  readonly retryAfter?: number;
  readonly installedBootstrapDigest?: string;
  readonly reasonCode?: string;
  readonly nativeVersion?: string;
  readonly qualificationState?: "qualified" | "unqualified" | "required" | "incompatible";
  readonly nativeContractDigest?: string;
  readonly qualificationRecordId?: string;
  readonly semanticProfile?: V2NativeSemanticProfile;
}
export interface V2OwnedActivationJob {
  readonly id: string;
  readonly scope: V2ActivationJobScope;
  readonly permit: V2ConsentPermit;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly connection: Awaited<ReturnType<typeof borrowV2SharedService>>;
  readonly assertCurrent: () => void;
  readonly phase: (state: V2ActivationState, reason?: string) => void;
  readonly installed: (bootstrapDigest: string, proof?: V2NativeRuntimeProof) => void;
}
interface Interest {
  continuation: boolean;
  detach: () => void;
}
interface Job {
  readinessFailure?: V2ReadinessFailure;
  readonly id: string;
  readonly key: string;
  readonly scope: V2ActivationJobScope;
  readonly permit: V2ConsentPermit;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly interests: Map<string, Interest>;
  timer: ReturnType<typeof setTimeout>;
  status: V2ActivationJobStatus;
  promise: Promise<void>;
  settled: boolean;
}

/** Coordinator owns tracked permits/connections past RPC wait timeout, never the request's released permit. */
export class V2ActivationJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly keys = new Map<string, Job>();
  private closed = false;
  constructor(
    private readonly consent: V2ConsentAuthority,
    private readonly run: (job: V2OwnedActivationJob) => Promise<void>,
    private readonly borrow = borrowV2SharedService,
    private readonly now = Date.now,
  ) {}
  request(scope: V2ActivationJobScope, signal?: AbortSignal): V2ActivationHandle {
    if (this.closed) throw new Error("V2 activation service is closed.");
    signal?.throwIfAborted();
    const key = JSON.stringify([
      scope.root,
      scope.issuer,
      scope.registrationId,
      scope.transport,
      scope.generation,
      scope.consentRevision,
      scope.digest,
    ]);
    let job = this.keys.get(key);
    if (!job || job.settled) {
      for (const existing of this.keys.values())
        if (
          !existing.settled &&
          existing.scope.root === scope.root &&
          existing.scope.issuer === scope.issuer &&
          existing.scope.registrationId === scope.registrationId
        )
          throw new Error("V2 conflicting activation proposal/physical writer remains owned.");
      if (this.jobs.size >= 32) {
        for (const [id, completed] of this.jobs)
          if (completed.settled) {
            this.jobs.delete(id);
            break;
          }
        if (this.jobs.size >= 32) throw new Error("V2 activation job/quarantine capacity reached.");
      }
      const permit = this.consent.capture();
      if (permit.revision !== scope.consentRevision) {
        permit.release();
        throw new Error("V2 activation scope revision changed before acquisition.");
      }
      const controller = new AbortController(),
        id = randomBytes(16).toString("hex"),
        deadline = this.now() + 300000;
      const timer = setTimeout(() => controller.abort(), 300000);
      timer.unref();
      job = {
        ...(scope.readinessFailure ? { readinessFailure: scope.readinessFailure } : {}),
        id,
        key,
        scope,
        permit,
        controller,
        deadline,
        timer,
        interests: new Map(),
        status: {
          jobId: id,
          state: "checking",
          desiredDigest: scope.digest,
          ...(scope.readinessFailure
            ? { reason: v2ReadinessSetupReason(scope.readinessFailure)! }
            : {}),
        },
        promise: Promise.resolve(),
        settled: false,
      };
      this.jobs.set(id, job);
      this.keys.set(key, job);
      const owned = job;
      owned.promise = runDetachedV2Caller(() => Promise.resolve().then(() => this.execute(owned)));
      void owned.promise.catch(() => {});
    }
    job.permit.assertCurrent();
    job.controller.signal.throwIfAborted();
    if (!job.readinessFailure && scope.readinessFailure) {
      job.readinessFailure = scope.readinessFailure;
      job.status = {
        ...job.status,
        reason: v2ReadinessSetupReason(job.readinessFailure, job.status.reason)!,
      };
    }
    if (job.interests.size >= 32) throw new Error("V2 activation interest capacity reached.");
    const interestId = randomBytes(16).toString("hex"),
      owned = job;
    const abort = () => this.cancel({ jobId: owned.id, interestId }, scope);
    signal?.addEventListener("abort", abort, { once: true });
    job.interests.set(interestId, {
      continuation: false,
      detach: () => signal?.removeEventListener("abort", abort),
    });
    return { jobId: job.id, interestId };
  }
  status(jobId: string, scope: V2ActivationJobScope): V2ActivationJobStatus {
    const job = this.owned(jobId, scope);
    return { ...job.status };
  }
  isSettled(jobId: string) {
    return this.jobs.get(jobId)?.settled !== false;
  }
  async wait(
    handle: V2ActivationHandle,
    scope: V2ActivationJobScope,
    signal?: AbortSignal,
  ): Promise<V2ActivationJobStatus> {
    const job = this.owned(handle.jobId, scope),
      interest = job.interests.get(handle.interestId);
    if (!interest) throw new Error("V2 activation interest is absent; status cannot create work.");
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 30000);
      timer.unref();
    });
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("V2 activation waiter cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([
        job.promise.then(() => "settled" as const),
        timeout,
        cancelled,
      ]);
      job.permit.assertCurrent();
      signal?.throwIfAborted();
      if (result === "timeout" && !job.settled) {
        interest.continuation = true;
        if (job.status.state === "uncertain") return { ...job.status };
        return { ...job.status, state: "waiting-for-idle", retryAfter: 2000 };
      }
      return { ...job.status };
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  cancel(handle: V2ActivationHandle, scope: V2ActivationJobScope) {
    const job = this.owned(handle.jobId, scope),
      interest = job.interests.get(handle.interestId);
    if (!interest) return;
    interest.detach();
    job.interests.delete(handle.interestId);
    if (!job.interests.size && !job.settled) job.controller.abort();
  }
  private owned(id: string, scope: V2ActivationJobScope) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.scope.root !== scope.root ||
      job.scope.issuer !== scope.issuer ||
      job.scope.registrationId !== scope.registrationId ||
      job.scope.transport !== scope.transport ||
      job.scope.generation !== scope.generation ||
      job.scope.consentRevision !== scope.consentRevision
    )
      throw new Error("V2 activation handle belongs to another scope/owner.");
    return job;
  }
  private async execute(job: Job) {
    const signal = AbortSignal.any([job.permit.signal, job.controller.signal]);
    let connection: Awaited<ReturnType<typeof borrowV2SharedService>> | undefined;
    const assertCurrent = () => {
      job.permit.assertCurrent();
      signal.throwIfAborted();
      if (this.closed || this.now() >= job.deadline || !job.interests.size)
        throw new Error("V2 activation continuation has expired/lost all interests.");
    };
    try {
      await runV2RequestContext(
        { permit: job.permit, transport: job.scope.transport, intent: "execute" },
        async () => {
          assertCurrent();
          connection = await this.borrow(job.scope.descriptor);
          assertCurrent();
          await this.run({
            id: job.id,
            scope: job.scope,
            permit: job.permit,
            signal,
            deadline: job.deadline,
            connection,
            assertCurrent,
            installed: (bootstrapDigest, proof) => {
              assertCurrent();
              if (!/^[a-f0-9]{64}$/.test(bootstrapDigest))
                throw new Error("V2 verified bootstrap identity rejected.");
              proof?.assertCurrent();
              if (
                proof &&
                (proof.root !== job.scope.root ||
                  proof.transport !== job.scope.transport ||
                  proof.generation !== job.scope.generation)
              )
                throw new Error("V2 installed qualification proof scope changed.");
              job.status = {
                ...job.status,
                installedBootstrapDigest: bootstrapDigest,
                ...(proof
                  ? {
                      ...v2NativeProofMetadata(proof),
                    }
                  : {}),
              };
            },
            phase: (state, reason) => {
              // Uncertainty is observational evidence, never renewed execution authority.
              if (state !== "uncertain") assertCurrent();
              job.status = {
                ...job.status,
                jobId: job.id,
                state,
                desiredDigest: job.scope.digest,
                ...(reason || job.readinessFailure
                  ? { reason: v2ReadinessSetupReason(job.readinessFailure, reason)! }
                  : {}),
                ...(state === "waiting-for-idle" ? { retryAfter: 2000 } : {}),
              };
            },
          });
          assertCurrent();
          job.status = {
            ...job.status,
            jobId: job.id,
            state: "ready",
            desiredDigest: job.scope.digest,
          };
        },
      );
    } catch (error) {
      job.status = {
        jobId: job.id,
        state:
          job.status.state === "uncertain"
            ? "uncertain"
            : signal.aborted
              ? "cancelled"
              : error instanceof V2NativeCompatibilityError
                ? "blocked"
                : "failed",
        desiredDigest: job.scope.digest,
        ...(error instanceof V2NativeCompatibilityError
          ? {
              reasonCode: error.reasonCode,
              nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
              ...(error.nativeVersion ? { nativeVersion: error.nativeVersion } : {}),
              qualificationState:
                error.reasonCode === "native-qualification-required"
                  ? ("required" as const)
                  : ("incompatible" as const),
            }
          : {}),
        reason: v2ReadinessSetupReason(
          job.readinessFailure,
          error instanceof Error && error.message.startsWith("V2 ")
            ? error.message
            : "V2 activation did not verify; history/uncertain evidence was retained.",
        )!,
      };
    } finally {
      clearTimeout(job.timer);
      job.controller.abort();
      for (const interest of job.interests.values()) interest.detach();
      // Await owned physical work/close: capacity remains occupied until this finalizer actually settles.
      try {
        await connection?.close();
      } finally {
        job.permit.release();
        job.settled = true;
        if (this.keys.get(job.key) === job) this.keys.delete(job.key);
      }
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }
}
