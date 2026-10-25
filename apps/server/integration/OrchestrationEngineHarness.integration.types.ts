import * as Effect from "effect/Effect";
import type { Duration } from "effect";

import type { OrchestrationEvent, OrchestrationThread, ProviderKind } from "@bigbud/contracts";

import type { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import type { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import type { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import type { OrchestrationEngineShape } from "../src/orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationRuntimeReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import type { ProviderService } from "../src/provider/Services/ProviderService.ts";

import type { TestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.types.ts";

export interface PendingApprovalRow {
  readonly status: "pending" | "resolved";
  readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
  readonly resolvedAt: string | null;
}

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly checkpointStore: CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: PendingApprovalRow) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<PendingApprovalRow, never>;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  readonly advanceClock: (duration: Duration.Input) => Effect.Effect<void, never>;
  readonly dispose: Effect.Effect<void, never>;
}

export interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderKind;
  readonly realCodex?: boolean;
  readonly testClock?: boolean;
  /** Run the harness database on the SQLite worker thread, as production does (default true). */
  readonly sqliteWorker?: boolean;
  /** Reuse a state directory the caller owns, to boot on a database a previous run left. */
  readonly rootDir?: string;
  /** Turn responses for the next provider session, queued before the reactors start. */
  readonly nextSessionTurnResponses?: ReadonlyArray<TestTurnResponse>;
  /** Runs after the engine is built and before the reactors subscribe, as startup phases do. */
  readonly beforeReactorStart?: (engine: OrchestrationEngineShape) => Effect.Effect<void>;
}
