import type { MuseSettings, ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import type { Effect, Ref } from "effect";

import type { ProviderAdapterError } from "../../Errors.ts";
import type { MuseSessionBindingsShape } from "../../../persistence/Services/MuseSessionBindings.ts";
import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import type { MuseHostFactory, MuseTransport } from "./Client.ts";
import type { MuseApprovalRequestParams } from "./Client.schema.ts";
import type { MuseUsageObservations } from "./Usage.observations.ts";

export interface MuseBridgeHandle {
  readonly config: Record<string, unknown>;
  readonly cleanup: () => Promise<void>;
}

export interface MuseAdapterDeps {
  readonly hostFactory: MuseHostFactory;
  readonly getSettings: Effect.Effect<MuseSettings, ProviderAdapterError>;
  /** False only on an unknown or withdrawn platform (see MUSE_PLATFORM_QUALIFICATION). */
  readonly platformQualified: boolean;
  readonly bindings?: MuseSessionBindingsShape;
  readonly admissions?: ProviderTurnAdmissionsShape;
  /** Receives `usage/changed` from session hosts; defaults to the process-wide store. */
  readonly usageObservations?: MuseUsageObservations;
  readonly bridgeFactory?: (
    threadId: ThreadId,
    nativeSessionId: string,
  ) => Effect.Effect<MuseBridgeHandle, ProviderAdapterError>;
}

/** Shared context handed to the Adapter.* concern modules. */
export interface MuseAdapterContext {
  readonly deps: MuseAdapterDeps;
  readonly sessionsRef: Ref.Ref<Map<ThreadId, MuseSessionState>>;
  readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<boolean>;
  readonly getSession: (
    threadId: ThreadId,
  ) => Effect.Effect<MuseSessionState, ProviderAdapterError>;
  readonly requireUsable: () => Effect.Effect<MuseSettings, ProviderAdapterError>;
}

export interface MusePendingApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly requirementId: { readonly approvalId: string; readonly sourceIndex: number };
  readonly choices: MuseApprovalRequestParams["availableChoices"];
  readonly requestId: string;
}

export interface MusePendingUserInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
}

export interface MuseLiveItem {
  readonly kind: string;
  readonly turnId: string | undefined;
}

export interface MuseSessionState {
  readonly threadId: ThreadId;
  readonly transport: MuseTransport;
  readonly nativeSessionId: string;
  readonly workspace: string;
  readonly model: string;
  readonly subProviderID: string;
  readonly runtimeMode: string;
  /** Orchestration session epoch; stamped on every runtime event so ingestion's epoch fence admits them. */
  readonly sessionEpoch: number;
  readonly createdAt: string;
  /** Advances only when the reported session view changes, so reconciliation sees stable state. */
  updatedAt: string;
  activeTurnId: TurnId | undefined;
  /** Last turn whose terminal arrived; a late turn/start ack must not reactivate it. */
  lastSettledTurnId: string | undefined;
  /** Live items by native itemId: `item/delta` carries neither the turn nor the item kind. */
  readonly items: Map<string, MuseLiveItem>;
  /** Queued submissions by native turnId; original submission commandId is the journal identity. */
  readonly queuedTurns: Map<string, { readonly commandId: string }>;
  /** SDK root queue entries lack turn IDs; preserve busy state without inventing identities. */
  hasUnidentifiedQueuedInputs?: boolean;
  readonly pendingApprovals: Map<string, MusePendingApproval>;
  readonly pendingUserInputs: Map<string, MusePendingUserInput>;
  /** Foreground journal rows by native turn ID, settled on terminal evidence. */
  readonly journalTurns: Map<string, ProviderTurnAdmission>;
  /** Bounded evidence retained only while a turn/start acknowledgement is in flight. */
  readonly inFlightStarts?: Map<
    string,
    {
      readonly observed: Map<string, "started" | "completed" | "failed" | "interrupted">;
      overflow: boolean;
    }
  >;
  readonly cleanupBridge: () => Promise<void>;
  closed: boolean;
}
