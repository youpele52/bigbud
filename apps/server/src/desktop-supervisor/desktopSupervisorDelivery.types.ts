import type {
  OrchestrationApplicationAckInput,
  OrchestrationApplicationAckResult,
  OrchestrationBaselineAckInput,
  OrchestrationBaselineAckResult,
  OrchestrationDeliveryStreamItem,
} from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationDeliverySessionEndReason } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import type { DesktopSupervisorOwnerClient } from "./desktopSupervisorOwnerClient.ts";

export interface DesktopSupervisorOwner {
  readonly attach: DesktopSupervisorOwnerClient["attach"];
  readonly detach: DesktopSupervisorOwnerClient["detach"];
  readonly enqueue: DesktopSupervisorOwnerClient["enqueue"];
  readonly acknowledge: DesktopSupervisorOwnerClient["acknowledge"];
  readonly installBaseline: DesktopSupervisorOwnerClient["installBaseline"];
  readonly heartbeat: DesktopSupervisorOwnerClient["heartbeat"];
  readonly onFailure: DesktopSupervisorOwnerClient["onFailure"];
  readonly onFrame: DesktopSupervisorOwnerClient["onFrame"];
  readonly close: DesktopSupervisorOwnerClient["close"];
}

export interface DesktopSupervisorSubscription {
  readonly consumerId: string;
  readonly offer: (event: OrchestrationEvent) => Promise<boolean>;
  readonly take: () => Promise<OrchestrationDeliveryStreamItem | null>;
  readonly close: () => void;
  /** Why the session ended itself (shutdown, superseded, failure); null while open or client-closed. */
  readonly endReason?: () => OrchestrationDeliverySessionEndReason | null;
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
  /** Any open supervised delivery consumer (desktop or web, not mobile): a user could answer (OD6). */
  readonly hasOpenConsumer: () => boolean;
}
