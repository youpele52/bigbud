export const DESKTOP_SUPERVISOR_PROTOCOL_MAJOR = 1;
export const DESKTOP_SUPERVISOR_PROTOCOL_MINOR = 1;
export const DESKTOP_SUPERVISOR_MAX_FRAME_BYTES = 1024 * 1024;

export interface DesktopSupervisorLimits {
  readonly maxFrameBytes: number;
  readonly maxConsumers: number;
  readonly maxQueueEvents: number;
  readonly maxQueueBytes: number;
  readonly maxInFlightEvents: number;
  readonly acknowledgementTimeoutMs: number;
}

export const DEFAULT_DESKTOP_SUPERVISOR_LIMITS: DesktopSupervisorLimits = {
  maxFrameBytes: DESKTOP_SUPERVISOR_MAX_FRAME_BYTES,
  maxConsumers: 5,
  maxQueueEvents: 2_000,
  maxQueueBytes: 16 * 1024 * 1024,
  maxInFlightEvents: 256,
  acknowledgementTimeoutMs: 15_000,
};

export interface DesktopSupervisorEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly canonicalPayload: Uint8Array;
}

export interface DesktopSupervisorEventBatch {
  readonly batchId: string;
  readonly serverEpoch: string;
  readonly subscriptionGeneration: number;
  readonly consumerId: string;
  readonly consumerGeneration: number;
  readonly events: ReadonlyArray<DesktopSupervisorEvent>;
}

export interface DesktopSupervisorApplicationAck {
  readonly batchId: string;
  readonly consumerId: string;
  readonly consumerGeneration: number;
  readonly receivedThroughSequence: number;
  readonly appliedThroughSequence: number;
  readonly applicationDurationMs: number;
}

export type DesktopSupervisorFrame =
  | {
      readonly type: "clientHello";
      readonly value: {
        readonly protocolMajor: number;
        readonly protocolMinor: number;
        readonly clientInstanceId: string;
        readonly requestedLimits: DesktopSupervisorLimits;
      };
    }
  | {
      readonly type: "supervisorHello";
      readonly value: {
        readonly protocolMajor: number;
        readonly protocolMinor: number;
        readonly supervisorInstanceId: string;
        readonly acceptedLimits: DesktopSupervisorLimits;
      };
    }
  | {
      readonly type: "attachConsumer";
      readonly value: {
        readonly consumerId: string;
        readonly consumerGeneration: number;
        readonly serverEpoch: string;
        readonly appliedSequence: number;
      };
    }
  | {
      readonly type: "consumerAttached";
      readonly value: {
        readonly consumerId: string;
        readonly consumerGeneration: number;
        readonly acknowledgedSequence: number;
      };
    }
  | {
      readonly type: "detachConsumer";
      readonly value: {
        readonly consumerId: string;
        readonly consumerGeneration: number;
        readonly reason: string;
      };
    }
  | { readonly type: "eventBatch"; readonly value: DesktopSupervisorEventBatch }
  | { readonly type: "applicationAck"; readonly value: DesktopSupervisorApplicationAck }
  | {
      readonly type: "applicationAckAccepted";
      readonly value: {
        readonly batchId: string;
        readonly consumerId: string;
        readonly consumerGeneration: number;
        readonly acknowledgedSequence: number;
      };
    }
  | { readonly type: "heartbeat"; readonly value: { readonly monotonicMillis: number } }
  | {
      readonly type: "recoveryRequired";
      readonly value: {
        readonly consumerId: string;
        readonly consumerGeneration: number;
        readonly kind: number;
        readonly fromSequenceExclusive: number;
        readonly reasonCode: string;
      };
    }
  | { readonly type: "metricsSnapshot" }
  | { readonly type: "shutdown"; readonly value: { readonly reason: string } }
  | {
      readonly type: "protocolError";
      readonly value: { readonly code: string; readonly message: string };
    };

export class DesktopSupervisorProtocolError extends Error {
  readonly _tag = "DesktopSupervisorProtocolError";

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DesktopSupervisorProtocolError";
  }
}

export function isDesktopSupervisorIncompatibleProtocolError(
  cause: unknown,
): cause is DesktopSupervisorProtocolError {
  return cause instanceof DesktopSupervisorProtocolError && cause.code === "incompatible_protocol";
}
