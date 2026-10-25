import { realpath } from "node:fs/promises";
import { v2OwnerRegistration } from "./Orchestration.registration.ts";
import { runV2Cleanup } from "./Client.guard.ts";
import { logV2SettlementDiagnostic } from "./Runtime.settlement.log.ts";
import { callV2ThreadRpc } from "./Client.guard.orchestration.ts";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  V2EnrollmentRetirement,
  type V2RetirementIdentity,
} from "./Orchestration.enrollment.retirement.ts";
import { V2_DEAD_BACKEND_PROOF } from "./Orchestration.enrollment.retirement.deadBackend.ts";
import {
  decodeV2EnrollmentRecord,
  v2CleanupEnvelope,
  type V2AnyEnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import {
  validateV2LeaseInspection,
  type V2EnrollmentAcknowledgement,
} from "./Orchestration.enrollment.ack.ts";
import {
  ensureV2ReceiptFence,
  readV2OwnerMarker,
  writeV2OwnerMarker,
  type V2BackendInstance,
  type V2ReceiptFence,
} from "./Orchestration.instances.ts";

/** User-facing refusals keep the "V2 " prefix and never match the busy-turn pattern. */
export const V2_DEAD_BACKEND_MESSAGES = {
  nativeActive:
    "V2 OpenCode is still running a turn on this thread that was started before bigbud restarted. Let it finish or stop it in OpenCode, then send again; nothing was replayed.",
  ownerAlive: (pid: number) =>
    `V2 the previous bigbud backend for this thread (pid ${pid}) is still running; stop it, then send again.`,
  ownerOtherHost: (ownerHost: string, thisHost: string) =>
    `V2 the previous bigbud backend for this thread ran on host "${ownerHost}", not this host "${thisHost}", so bigbud cannot prove it exited and keeps its records. If this is the same machine (hostnames can change with the network), continue in a new thread. Nothing was replayed.`,
  lockUnproved:
    "V2 cannot prove the previous bigbud backend exited (backend lock not held by this process); restart bigbud. Nothing was replayed.",
  nativeUnconfirmed:
    "V2 OpenCode did not confirm release of the previous thread-tools enrollment; check OpenCode is running with bigbud thread tools, then send again. Nothing was replayed.",
  fenceUnavailable:
    "V2 dead-backend recovery is disabled for this bigbud backend because its receipt fence could not be written at startup; check the bigbud state directory is writable, then restart bigbud. Nothing was replayed.",
} as const;
const DEADLINE_MS = 15000;

export interface V2DeadBackendContext {
  readonly instance: V2BackendInstance;
  /** Absent when the fence could not be written at this instance's first open: recovery refuses. */
  readonly fence: V2ReceiptFence | undefined;
  readonly transport: string | undefined;
  readonly nativeSessionActive: (nativeSessionId: string, signal: AbortSignal) => Promise<boolean>;
  readonly rpc: (
    operation: "inspect" | "detach",
    owner: V2AnyEnrollmentOwner,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

/** Exact-original-owner cleanup envelopes (persistent issuer) plus the official activity list. */
export function makeV2DeadBackendContext(input: {
  readonly instance: V2BackendInstance;
  readonly fence: V2ReceiptFence | undefined;
  readonly privateKey: string;
  readonly client: OpencodeV2Client;
  readonly transport: string | undefined;
}): V2DeadBackendContext {
  return {
    instance: input.instance,
    fence: input.fence,
    transport: input.transport,
    nativeSessionActive: async (nativeSessionId, signal) =>
      Boolean(
        (
          await v2Request(
            "dead-backend session.active",
            (requestSignal) => input.client.session.active({ signal: requestSignal }),
            { timeoutMs: 5000, signal },
          )
        )[nativeSessionId],
      ),
    rpc: (operation, owner, signal) =>
      callV2ThreadRpc(
        input.client,
        owner.directory,
        operation,
        v2CleanupEnvelope(owner, operation, input.privateKey),
        owner.nativeSessionId,
        undefined,
        signal,
        v2OwnerRegistration(owner),
      ),
  };
}

/** Attribution plus the per-instance receipt fence. Only an instance whose lock covers exactly
 * this thread-tools state directory may attribute owners or prove other instances dead. */
export async function prepareV2DeadBackendRecovery(input: {
  readonly stateDir: string;
  readonly instance: V2BackendInstance | undefined;
  readonly records: V2ThreadRecords;
  readonly privateKey: string;
}) {
  const { instance, records } = input;
  if (!instance) return undefined;
  const [held, local] = await Promise.all([
    realpath(instance.stateDir).catch(() => undefined),
    realpath(input.stateDir).catch(() => undefined),
  ]);
  if (!held || held !== local) return undefined;
  const fence = await receiptFenceOnce(records, instance);
  return {
    fence,
    recordOwner: (digest: string, nonce: string) =>
      writeV2OwnerMarker(records, instance, digest, nonce),
    context: (client: OpencodeV2Client, transport: string | undefined) =>
      makeV2DeadBackendContext({
        instance,
        fence,
        privateKey: input.privateKey,
        client,
        transport,
      }),
  };
}

/** One fence attempt per backend instance (lock nonce) for the process lifetime. A later open
 * never builds a late fence: it could capture this live instance's own reserved receipts. A failed
 * first attempt therefore keeps dead-backend recovery disabled (fail closed) until restart. */
const fenceAttempts = new Map<string, Promise<V2ReceiptFence | undefined>>();
function receiptFenceOnce(records: V2ThreadRecords, instance: V2BackendInstance) {
  let attempt = fenceAttempts.get(instance.nonce);
  if (!attempt) {
    attempt = ensureV2ReceiptFence(records, instance).catch((error: unknown) => {
      logV2SettlementDiagnostic(
        "OpenCode v2 dead-backend receipt fence could not be written; dead-backend recovery is disabled for this backend instance",
        {
          errorName: error instanceof Error ? error.name : "UnknownFailure",
          ...(error instanceof Error && "code" in error && typeof error.code === "string"
            ? { errorCode: error.code }
            : {}),
        },
      );
      return undefined;
    });
    fenceAttempts.set(instance.nonce, attempt);
  }
  return attempt;
}

const inflight = new Map<string, Promise<void>>();

/** Shared by both entry points: settled retirement passes unchanged; otherwise, only with a
 * dead-backend context, the provably dead owner is retired once (single flight per identity). */
export async function settleV2PreviousRetirement(
  records: V2ThreadRecords,
  saved: NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>,
  identity: V2RetirementIdentity,
  context?: V2DeadBackendContext,
) {
  const retirement = await V2EnrollmentRetirement.open(records);
  try {
    await retirement.assertSettled(identity);
    return;
  } catch (error) {
    if (!context) throw error;
    const key = JSON.stringify(identity);
    let running = inflight.get(key);
    if (!running) {
      const started = retireDeadBackend(records, saved, identity, context, error).finally(() => {
        if (inflight.get(key) === started) inflight.delete(key);
      });
      inflight.set(key, started);
      running = started;
    }
    await running;
    await retirement.assertSettled(identity);
  }
}

async function retireDeadBackend(
  records: V2ThreadRecords,
  saved: NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>,
  identity: V2RetirementIdentity,
  context: V2DeadBackendContext,
  original: unknown,
) {
  const previous = decodeV2EnrollmentRecord(saved.value),
    owner = previous.owner;
  try {
    await context.instance.assertHeld();
  } catch {
    throw new Error(V2_DEAD_BACKEND_MESSAGES.lockUnproved);
  }
  const marker = await readV2OwnerMarker(records, previous.digest);
  if (marker?.backendInstance === context.instance.nonce) throw original; // Our own owner.
  if (marker) {
    const liveness = context.instance.classifyOwner(marker);
    if (liveness === "live") throw new Error(V2_DEAD_BACKEND_MESSAGES.ownerAlive(marker.pid));
    if (liveness === "foreign-host")
      throw new Error(
        V2_DEAD_BACKEND_MESSAGES.ownerOtherHost(marker.hostname, context.instance.hostname),
      );
    if (liveness !== "dead") throw new Error(V2_DEAD_BACKEND_MESSAGES.lockUnproved);
  }
  const fence = context.fence;
  if (!fence) throw new Error(V2_DEAD_BACKEND_MESSAGES.fenceUnavailable, { cause: original });
  const retirement = await V2EnrollmentRetirement.open(records);
  const current = await retirement.state(identity);
  const stalledReboot = current?.phase === "reboot-prepared" && !!current.rebootCheckpointDigest;
  if (current && !stalledReboot && !["retiring", "detach-acknowledged"].includes(current.phase))
    throw original; // Settled evidence that fails verification is preserved, never rewritten.
  await runWithAbortableDeadline({
    operation: "V2 dead-backend retirement",
    timeoutMs: DEADLINE_MS,
    run: (signal) =>
      runV2Cleanup(
        context.transport,
        owner.nativeSessionId,
        async () => {
          let active: boolean;
          try {
            active = await context.nativeSessionActive(owner.nativeSessionId, signal);
          } catch (cause) {
            throw new Error(V2_DEAD_BACKEND_MESSAGES.nativeUnconfirmed, { cause });
          }
          if (active) throw new Error(V2_DEAD_BACKEND_MESSAGES.nativeActive);
          signal.throwIfAborted();
          if (stalledReboot) await retirement.supersedeStalledReboot(identity);
          const phase = await retirement.begin(identity, saved);
          if (phase === "retiring")
            try {
              const inspected = validateV2LeaseInspection(
                (await context.rpc("inspect", owner, signal)) as V2EnrollmentAcknowledgement,
                { digest: previous.digest, nonce: owner.enrollmentNonce },
                [previous.acknowledged, previous.pending],
              );
              const ack = await context.rpc("detach", owner, signal);
              signal.throwIfAborted();
              await retirement.acknowledge(
                identity,
                ack,
                inspected,
                "bootstrapDigest" in owner ? owner.bootstrapDigest : owner.artifactDigest,
                owner.transportGeneration,
              );
            } catch (cause) {
              throw new Error(V2_DEAD_BACKEND_MESSAGES.nativeUnconfirmed, { cause });
            }
          signal.throwIfAborted();
          await retirement.settle(identity, {
            kind: V2_DEAD_BACKEND_PROOF,
            settlingBackendInstance: context.instance.nonce,
            settlingPid: context.instance.pid,
            ownerBackendInstance: marker?.backendInstance ?? null,
            nativeInactiveObservedAt: new Date().toISOString(),
            receiptFence: { instance: fence.instance, digest: fence.digest },
            receiptsSettled: fence.receipts.size === 0,
          });
        },
        signal,
      ),
  });
}
