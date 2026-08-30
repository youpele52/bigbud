import type {
  OrchestrationBaselineAckResult,
  OrchestrationDeliveryBatch,
  OrchestrationDeliveryRecovery,
  OrchestrationEvent,
} from "@bigbud/contracts";

import { applyAndAcknowledgeDeliveryBatch } from "./-__root.delivery-ack";

type DeliveryAction = "ignore" | "defer" | "recover" | "apply";
// Keep this below the server's 65-second recovery-gate expiry.
const BASELINE_RECOVERY_DEADLINE_MS = 60_000;
const BASELINE_ACK_RETRY_INITIAL_DELAY_MS = 250;
const BASELINE_ACK_RETRY_MAX_DELAY_MS = 2_000;
const BASELINE_ACK_TIMEOUT_MS = 20_000;

function waitForBaselineAcknowledgement<T>(input: {
  readonly operation: Promise<T>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<T> {
  if (input.signal?.aborted) {
    return Promise.reject(new Error("Delivery baseline acknowledgement was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const finish = (operation: () => void) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () =>
      finish(() => reject(new Error("Delivery baseline acknowledgement was cancelled.")));
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Delivery baseline acknowledgement timed out."))),
      input.timeoutMs,
    );
    input.signal?.addEventListener("abort", abort, { once: true });
    input.operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function waitForBaselineRetry(input: {
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly durationMs: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) {
    return Promise.reject(new Error("Delivery baseline recovery was cancelled."));
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (operation: () => void) => {
      input.signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () =>
      finish(() => reject(new Error("Delivery baseline recovery was cancelled.")));
    input.signal?.addEventListener("abort", abort, { once: true });
    input.sleep(input.durationMs).then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function routeOrchestrationDeliveryBatch(input: {
  readonly batch: OrchestrationDeliveryBatch;
  readonly classify: (sequence: number) => DeliveryAction;
  readonly recover: () => Promise<void>;
  readonly apply: (events: ReadonlyArray<OrchestrationEvent>) => Promise<void>;
  readonly getAppliedSequence: () => number;
  readonly acknowledge: Parameters<typeof applyAndAcknowledgeDeliveryBatch>[0]["acknowledge"];
}) {
  const firstEvent = input.batch.events[0];
  if (!firstEvent) return Promise.resolve(null);

  const action = input.classify(firstEvent.sequence);
  return applyAndAcknowledgeDeliveryBatch({
    batch: input.batch,
    apply: async () => {
      if (action === "defer" || action === "recover") {
        await input.recover();
      }
      // Admission removes duplicates while retaining any later contiguous events in the batch.
      await input.apply(input.batch.events);
      return {
        appliedThroughSequence: Math.min(
          input.getAppliedSequence(),
          input.batch.events.at(-1)!.sequence,
        ),
      };
    },
    acknowledge: input.acknowledge,
  });
}

export async function recoverAndAcknowledgeDeliveryBaseline(input: {
  readonly recovery: OrchestrationDeliveryRecovery;
  readonly recover: () => Promise<number | null>;
  readonly acknowledge: (input: {
    readonly recoveryId: string;
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly serverEpoch: string;
    readonly appliedProjectionSequence: number;
    readonly applicationDurationMs: number;
  }) => Promise<OrchestrationBaselineAckResult>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly acknowledgementTimeoutMs?: number;
  readonly shouldAbort?: () => boolean;
  readonly sleep?: (durationMs: number) => Promise<void>;
  readonly recoveryDeadlineMs?: number;
}): Promise<OrchestrationBaselineAckResult> {
  const now = input.now ?? (() => performance.now());
  const shouldAbort = input.shouldAbort ?? (() => false);
  const sleep =
    input.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const deadlineAt = Date.now() + (input.recoveryDeadlineMs ?? BASELINE_RECOVERY_DEADLINE_MS);
  let retryCount = 0;
  for (;;) {
    if (shouldAbort() || input.signal?.aborted) {
      throw new Error("Delivery baseline recovery was cancelled.");
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Delivery baseline recovery deadline expired.");
    }
    const startedAt = now();
    const projectionSequence = await input.recover();
    if (projectionSequence === null) {
      throw new Error("Delivery baseline recovery did not produce a projection sequence.");
    }
    const acknowledgement = {
      recoveryId: input.recovery.recoveryId,
      consumerId: input.recovery.consumerId,
      consumerGeneration: input.recovery.consumerGeneration,
      serverEpoch: input.recovery.serverEpoch,
      appliedProjectionSequence: projectionSequence,
      applicationDurationMs: Math.max(0, Math.round(now() - startedAt)),
    };
    // RPC and transport failures intentionally propagate so WsTransport can reconnect.
    const result = await waitForBaselineAcknowledgement({
      operation: input.acknowledge(acknowledgement),
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: Math.min(
        input.acknowledgementTimeoutMs ?? BASELINE_ACK_TIMEOUT_MS,
        Math.max(1, deadlineAt - Date.now()),
      ),
    });
    if (result.accepted && !result.fenced) return result;
    if (result.fenced) throw new Error("Delivery baseline acknowledgement was fenced.");

    retryCount += 1;
    console.info(
      "[orchestration-recovery] Baseline acknowledgement not yet admissible; retrying.",
      {
        recoveryId: input.recovery.recoveryId,
        acknowledgedSequence: result.acknowledgedSequence,
        targetSequence: input.recovery.targetSequence,
        attemptedSequence: projectionSequence,
        retryCount,
        result: {
          accepted: result.accepted,
          fenced: result.fenced,
          acknowledgedSequence: result.acknowledgedSequence,
        },
      },
    );
    const delayMs = Math.min(
      BASELINE_ACK_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(retryCount - 1, 3),
      BASELINE_ACK_RETRY_MAX_DELAY_MS,
      Math.max(0, deadlineAt - Date.now()),
    );
    if (delayMs <= 0) {
      throw new Error("Delivery baseline recovery deadline expired.");
    }
    await waitForBaselineRetry({
      sleep,
      durationMs: delayMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
}
