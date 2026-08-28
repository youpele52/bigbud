import type {
  OrchestrationBaselineAckResult,
  OrchestrationDeliveryBatch,
  OrchestrationDeliveryRecovery,
  OrchestrationEvent,
} from "@bigbud/contracts";

import { applyAndAcknowledgeDeliveryBatch } from "./-__root.delivery-ack";

type DeliveryAction = "ignore" | "defer" | "recover" | "apply";
const BASELINE_ACK_MAX_ATTEMPTS = 3;
const BASELINE_RECOVERY_MAX_ATTEMPTS = 2;
const BASELINE_ACK_RETRY_DELAY_MS = 100;
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
}): Promise<OrchestrationBaselineAckResult> {
  const now = input.now ?? (() => performance.now());
  const shouldAbort = input.shouldAbort ?? (() => false);
  const sleep =
    input.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  let rejectedResult: OrchestrationBaselineAckResult | null = null;
  for (
    let recoveryAttempt = 0;
    recoveryAttempt < BASELINE_RECOVERY_MAX_ATTEMPTS;
    recoveryAttempt += 1
  ) {
    if (shouldAbort()) throw new Error("Delivery baseline recovery was cancelled.");
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
    for (let attempt = 1; attempt <= BASELINE_ACK_MAX_ATTEMPTS; attempt += 1) {
      if (shouldAbort()) throw new Error("Delivery baseline acknowledgement was cancelled.");
      let result: OrchestrationBaselineAckResult;
      try {
        result = await waitForBaselineAcknowledgement({
          operation: input.acknowledge(acknowledgement),
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.acknowledgementTimeoutMs ?? BASELINE_ACK_TIMEOUT_MS,
        });
      } catch (error) {
        if (attempt === BASELINE_ACK_MAX_ATTEMPTS || shouldAbort() || input.signal?.aborted) {
          throw error;
        }
        await sleep(BASELINE_ACK_RETRY_DELAY_MS * attempt);
        continue;
      }
      if (result.accepted && !result.fenced) return result;
      if (result.fenced) throw new Error("Delivery baseline acknowledgement was fenced.");
      rejectedResult = result;
      break;
    }
  }
  throw new Error(
    `Delivery baseline acknowledgement was rejected at sequence ${rejectedResult?.acknowledgedSequence ?? input.recovery.acknowledgedSequence}.`,
  );
}
