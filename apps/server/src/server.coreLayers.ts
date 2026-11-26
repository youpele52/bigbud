/**
 * Orchestration infrastructure, reactor and persistence layers, grouped so `server.ts` only
 * composes them into the runtime.
 *
 * @module server.coreLayers
 */
import * as Layer from "effect/Layer";

import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import {
  DefaultSchedulerConfigLive,
  SchedulerReactorLive,
} from "./orchestration/Layers/SchedulerReactor";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { ThreadWatchReactorLive } from "./orchestration/Layers/ThreadWatchReactor";
import { ThreadOrganizationReactorLive } from "./orchestration/Layers/ThreadOrganizationReactor.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationBootstrapRecipeRepositoryLive } from "./persistence/Layers/OrchestrationBootstrapRecipes.ts";
import { AutomationScheduleRepositoryLive } from "./persistence/Layers/AutomationScheduleRepository";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProjectionCatalogQueryLive } from "./orchestration/Layers/ProjectionCatalogQuery";
import { ProjectionOperationalStateQueryLive } from "./orchestration/Layers/ProjectionOperationalStateQuery";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { withRemoteExecutionTargetDisconnects } from "./persistence/Layers/RemoteExecutionTargetDisconnects.ts";
import { ProjectionNoteRepositoryLive } from "./persistence/Layers/ProjectionNotes";
import { ProjectionKanbanRepositoryLive } from "./persistence/Layers/ProjectionKanban";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadWatchRepositoryLive } from "./persistence/Layers/ProjectionThreadWatches";
import { LearningJobRepositoryLive } from "./persistence/Layers/LearningJobs";
import { SkillChangeProposalRepositoryLive } from "./persistence/Layers/SkillChangeProposals";
import { LearningReactorLive } from "./orchestration/Layers/LearningReactor";
import { MemoryStoreLive } from "./learning/Layers/MemoryStore";
import { ThreadRetentionRepositoryLive } from "./persistence/Layers/ThreadRetentionRepository.ts";
import { PurgeJobRepositoryLive } from "./persistence/Layers/PurgeJobRepository.ts";
import * as Recovery from "./server.recoveryLayers.ts";

export const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(
    OrchestrationReactorLive.pipe(
      Layer.provide(LearningReactorLive),
      Layer.provide(ThreadOrganizationReactorLive),
    ),
  ),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(Recovery.ProviderTurnSupervisorLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(SchedulerReactorLive),
  Layer.provideMerge(ThreadWatchReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
  Layer.provideMerge(DefaultSchedulerConfigLive),
);

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  OrchestrationBootstrapRecipeRepositoryLive,
);

const AutomationInfrastructureLayerLive = AutomationScheduleRepositoryLive;

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  ProjectionCatalogQueryLive,
  ProjectionOperationalStateQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  AutomationInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
  ThreadRetentionRepositoryLive,
  PurgeJobRepositoryLive,
  Recovery.RecoveryPersistenceLayerLive,
);

// Disconnect flags load before any SqlClient consumer, including remote-agent startup work.
export const PersistenceLayerLive = withRemoteExecutionTargetDisconnects(
  SqlitePersistenceLayerLive,
);

const NotesPersistenceLayerLive = ProjectionNoteRepositoryLive;
const KanbanPersistenceLayerLive = ProjectionKanbanRepositoryLive;
const ThreadProjectionPersistenceLayerLive = Layer.mergeAll(
  ProjectionThreadRepositoryLive,
  ProjectionProjectRepositoryLive,
);
export const ProjectionPersistenceLayerLive = Layer.mergeAll(
  KanbanPersistenceLayerLive,
  NotesPersistenceLayerLive,
  ThreadProjectionPersistenceLayerLive,
  ProjectionThreadWatchRepositoryLive,
  LearningJobRepositoryLive,
  SkillChangeProposalRepositoryLive,
  MemoryStoreLive,
);
