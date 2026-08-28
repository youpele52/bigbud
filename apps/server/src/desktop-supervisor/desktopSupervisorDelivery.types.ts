import type {
  OrchestrationApplicationAckInput,
  OrchestrationApplicationAckResult,
  OrchestrationBaselineAckInput,
  OrchestrationBaselineAckResult,
  OrchestrationDeliveryStreamItem,
} from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

export interface DesktopSupervisorSubscription {
  readonly consumerId: string;
  readonly offer: (event: OrchestrationEvent) => Promise<boolean>;
  readonly take: () => Promise<OrchestrationDeliveryStreamItem | null>;
  readonly close: () => void;
}

export interface DesktopSupervisorDeliveryShape {
  readonly open: (input: {
    readonly consumerId: string;
    readonly appliedSequence: number;
    readonly readReplay: (
      fromSequenceExclusive: number,
      limit?: number,
    ) => Promise<OrchestrationReplayEventsResult>;
  }) => Promise<DesktopSupervisorSubscription>;
  readonly acknowledge: (
    input: OrchestrationApplicationAckInput,
  ) => Promise<OrchestrationApplicationAckResult>;
  readonly acknowledgeBaseline: (
    input: OrchestrationBaselineAckInput,
  ) => Promise<OrchestrationBaselineAckResult>;
  readonly close: () => Promise<void>;
}
