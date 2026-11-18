import type { NativeApi, OrchestrationDeliveryLifecycle } from "@bigbud/contracts";
import type { WsRpcClient } from "./wsRpcClient.types";
import type { NativeDeliveryCursor } from "./orchestrationDeliveryCursor.scoped";
import {
  isWsSubscriptionListenerFailure,
  isWsTransportDisconnectedError,
  wsSubscriptionErrorCause,
} from "./wsTransport.errors";
import { cappedExponentialRetryDelay } from "./wsTransport.retry";

const MAX_ORCHESTRATION_NO_PROGRESS_FAILURES = 3;
const ORCHESTRATION_RETRY_BASE_DELAY_MS = 250;
const ORCHESTRATION_RETRY_MAX_DELAY_MS = 8_000;

type DeliveryMethods = Pick<
  NativeApi["orchestration"],
  "acknowledgeDelivery" | "acknowledgeDeliveryBaseline" | "onDomainEvent"
>;

/** One backend's stream, callbacks and applied cursor; disposal never acknowledges late work. */
export function createNativeDelivery(
  rpcClient: WsRpcClient,
  cursor: NativeDeliveryCursor,
  onLifecycle: (event: OrchestrationDeliveryLifecycle) => void,
) {
  const deliveryConsumerId = cursor.consumerId;
  let deliveryAppliedSequence = cursor.read();
  let disposed = false;
  type DomainEventCallback = Parameters<NativeApi["orchestration"]["onDomainEvent"]>[0];
  const domainEventCallbacks = new Set<DomainEventCallback>();
  const domainResubscribeCallbacks = new Set<() => void>();
  let activeBaselineRecovery: {
    readonly recoveryId: string;
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly serverEpoch: string;
  } | null = null;
  let unsubscribeDomainEvents: (() => void) | null = null;
  let orchestrationApplicationFailures = 0;
  let latestDeliveryIdentity: {
    readonly route: "direct-unmanaged" | "supervisor" | "fallback-fenced";
    readonly consumerGeneration: number;
    readonly acknowledgedSequence: number;
  } | null = null;

  const markDeliveryProgress = () => {
    orchestrationApplicationFailures = 0;
  };
  // An acknowledgement refused mid-batch because the socket dropped is not an application
  // failure; the resubscription replays from `deliveryAppliedSequence` and admission dedupes.
  const isApplicationFailure = (error: unknown) =>
    isWsSubscriptionListenerFailure(error) &&
    !isWsTransportDisconnectedError(wsSubscriptionErrorCause(error));

  const isActiveBaselineRecovery = (input: {
    readonly recoveryId: string;
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly serverEpoch: string;
  }) =>
    activeBaselineRecovery?.recoveryId === input.recoveryId &&
    activeBaselineRecovery.consumerId === input.consumerId &&
    activeBaselineRecovery.consumerGeneration === input.consumerGeneration &&
    activeBaselineRecovery.serverEpoch === input.serverEpoch;

  const ensureDomainEventSubscription = () => {
    if (disposed) throw new Error("Backend client disposed");
    if (unsubscribeDomainEvents) return;
    unsubscribeDomainEvents = rpcClient.orchestration.onDomainEvent(
      () => ({ consumerId: deliveryConsumerId, appliedSequence: deliveryAppliedSequence }),
      (item) => {
        if (disposed) return Promise.resolve();
        latestDeliveryIdentity = {
          route: item.route,
          consumerGeneration: item.consumerGeneration,
          acknowledgedSequence:
            item.type === "batch" ? deliveryAppliedSequence : item.acknowledgedSequence,
        };
        if (item.type === "recovery") {
          activeBaselineRecovery = {
            recoveryId: item.recoveryId,
            consumerId: item.consumerId,
            consumerGeneration: item.consumerGeneration,
            serverEpoch: item.serverEpoch,
          };
        } else if (item.type === "batch") {
          activeBaselineRecovery = null;
        }
        return Promise.all(Array.from(domainEventCallbacks, (callback) => callback(item))).then(
          () => undefined,
        );
      },
      {
        retryDelay: ({ error }) =>
          isApplicationFailure(error)
            ? cappedExponentialRetryDelay({
                attempt: orchestrationApplicationFailures,
                baseMs: ORCHESTRATION_RETRY_BASE_DELAY_MS,
                maxMs: ORCHESTRATION_RETRY_MAX_DELAY_MS,
              })
            : ORCHESTRATION_RETRY_BASE_DELAY_MS,
        onResubscribe: () => {
          if (disposed) return;
          activeBaselineRecovery = null;
          for (const callback of domainResubscribeCallbacks) callback();
        },
        shouldRetry: (error) => {
          if (disposed) return false;
          if (!isApplicationFailure(error)) return true;
          orchestrationApplicationFailures += 1;
          const identity = latestDeliveryIdentity;
          if (
            orchestrationApplicationFailures === MAX_ORCHESTRATION_NO_PROGRESS_FAILURES &&
            identity
          ) {
            onLifecycle({
              type: "lifecycle",
              route: identity.route,
              consumerId: deliveryConsumerId,
              consumerGeneration: identity.consumerGeneration,
              state: "degraded",
              acknowledgedSequence: identity.acknowledgedSequence,
              restartAttempt: 0,
              reasonCode: "application_no_progress",
            });
          }
          // The supervisor retains the authoritative cursor and will issue a
          // replay or baseline reset on the next generation. Stopping here
          // leaves persisted messages invisible until the renderer restarts.
          return true;
        },
      },
    );
  };

  const methods: DeliveryMethods = {
    acknowledgeDelivery: async (input) => {
      if (disposed) throw new Error("Backend client disposed");
      const result = await rpcClient.orchestration.acknowledgeDelivery(input);
      if (disposed)
        return { accepted: false, fenced: true, acknowledgedSequence: deliveryAppliedSequence };
      if (result.accepted && !result.fenced) {
        deliveryAppliedSequence = Math.max(deliveryAppliedSequence, result.acknowledgedSequence);
        cursor.write(deliveryAppliedSequence);
        markDeliveryProgress();
      }
      return result;
    },
    acknowledgeDeliveryBaseline: async (input) => {
      if (disposed) throw new Error("Backend client disposed");
      if (!isActiveBaselineRecovery(input)) {
        return { accepted: false, fenced: true, acknowledgedSequence: deliveryAppliedSequence };
      }
      const result = await rpcClient.orchestration.acknowledgeDeliveryBaseline(input);
      if (disposed)
        return { accepted: false, fenced: true, acknowledgedSequence: deliveryAppliedSequence };
      if (result.accepted && !result.fenced && isActiveBaselineRecovery(input)) {
        deliveryAppliedSequence = Math.max(deliveryAppliedSequence, result.acknowledgedSequence);
        cursor.write(deliveryAppliedSequence);
        markDeliveryProgress();
      } else if (result.accepted && !result.fenced) {
        return { accepted: false, fenced: true, acknowledgedSequence: deliveryAppliedSequence };
      }
      return result;
    },
    onDomainEvent: (callback, options) => {
      if (disposed) throw new Error("Backend client disposed");
      domainEventCallbacks.add(callback);
      if (options?.onResubscribe) domainResubscribeCallbacks.add(options.onResubscribe);
      ensureDomainEventSubscription();
      return () => {
        domainEventCallbacks.delete(callback);
        if (options?.onResubscribe) domainResubscribeCallbacks.delete(options.onResubscribe);
        if (domainEventCallbacks.size === 0) {
          activeBaselineRecovery = null;
          unsubscribeDomainEvents?.();
          unsubscribeDomainEvents = null;
        }
      };
    },
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    activeBaselineRecovery = null;
    domainEventCallbacks.clear();
    domainResubscribeCallbacks.clear();
    unsubscribeDomainEvents?.();
    unsubscribeDomainEvents = null;
  };
  return { methods, dispose };
}
