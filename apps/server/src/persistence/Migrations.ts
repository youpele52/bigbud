import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_ProjectionThreadsParentThread.ts";
import Migration0021 from "./Migrations/021_BackfillProjectionThreadShellSummary.ts";
import Migration0022 from "./Migrations/022_ProjectionProjectsNullableWorkspaceRoot.ts";
import Migration0023 from "./Migrations/023_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0024 from "./Migrations/024_ProjectionThreadSessionReason.ts";
import Migration0025 from "./Migrations/025_ProjectionThreadsDeletingAt.ts";
import Migration0026 from "./Migrations/026_ProjectionProjectsDeletingAt.ts";
import Migration0027 from "./Migrations/027_ProjectionThreadMessageReplies.ts";
import Migration0028 from "./Migrations/028_ExecutionTargets.ts";
import Migration0029 from "./Migrations/029_ProviderRuntimeWorkspaceExecutionTargets.ts";
import Migration0030 from "./Migrations/030_ProjectionRuntimeWorkspaceExecutionTargets.ts";
import Migration0031 from "./Migrations/031_ProjectionNotes.ts";
import Migration0032 from "./Migrations/032_AutomationSchedules.ts";
import Migration0033 from "./Migrations/033_AutomationSchedulesBackfillColumns.ts";
import Migration0034 from "./Migrations/034_AutomationSchedulesBackfillProjectId.ts";
import Migration0035 from "./Migrations/035_AutomationRunOccurrences.ts";
import Migration0036 from "./Migrations/036_AutomationRunTerminalEventId.ts";
import Migration0037 from "./Migrations/037_ProjectionThreadWatches.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsElevatorSummary.ts";
import Migration0039 from "./Migrations/039_LearningJobs.ts";
import Migration0040 from "./Migrations/040_SkillChangeProposals.ts";
import Migration0041 from "./Migrations/041_LearningJobMemoryUserMessageCount.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadsPurpose.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadActivityUsageIndex.ts";
import Migration0044 from "./Migrations/044_ProjectionUsageContributions.ts";
import Migration0045 from "./Migrations/045_RepairProjectionUsageContributions.ts";
import Migration0046 from "./Migrations/046_ProjectionThreadTasks.ts";
import Migration0047 from "./Migrations/047_ProviderSelectionQuarantine.ts";
import Migration0048 from "./Migrations/048_ThreadDelegations.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsParentProject.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadWatchesUniqueActive.ts";
import Migration0051 from "./Migrations/051_PurgeJobs.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadsPinnedAt.ts";
import Migration0053 from "./Migrations/053_ProjectionCatalogIndexes.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadDetailIndexes.ts";
import Migration0055 from "./Migrations/055_ProjectionPendingUserInputs.ts";
import Migration0056 from "./Migrations/056_ProjectionBaselines.ts";
import Migration0057 from "./Migrations/057_OrchestrationThreadIdentity.ts";
import Migration0058 from "./Migrations/058_RepairProjectionNotes.ts";
import Migration0059 from "./Migrations/059_ResumablePurgeBaseline.ts";
import Migration0060 from "./Migrations/060_ProjectionCatalogUserMessageIndex.ts";
import Migration0061 from "./Migrations/061_ProjectionChatsCreatedIndex.ts";
import Migration0062 from "./Migrations/062_ProjectionThreadQueuedPrompts.ts";
import Migration0063 from "./Migrations/063_ThreadRetentionFoundation.ts";
import Migration0064 from "./Migrations/064_CheckpointRetentionIdentity.ts";
import Migration0065 from "./Migrations/065_ThreadRetentionSecurityHardening.ts";
import Migration0066 from "./Migrations/066_PurgeExecutionLeases.ts";
import Migration0067 from "./Migrations/067_ThreadRetentionPolicyAuthority.ts";
import Migration0068 from "./Migrations/068_ThreadRetentionSafetyRecovery.ts";
import Migration0069 from "./Migrations/069_ThreadRetentionManualRecovery.ts";
import Migration0070 from "./Migrations/070_ThreadAttachmentReferences.ts";
import Migration0071 from "./Migrations/071_ProjectionThreadPendingInterruptFlushIntent.ts";
import Migration0072 from "./Migrations/072_ProjectionProjectCatalogScopeIndexes.ts";
import Migration0073 from "./Migrations/073_ProviderTurnLiveness.ts";
import Migration0074 from "./Migrations/074_ThreadRetentionQueuedRuns.ts";
import Migration0076 from "./Migrations/076_ThreadRetentionItemRetries.ts";
import Migration0077 from "./Migrations/077_AutomationOwnedThreads.ts";
import Migration0078 from "./Migrations/078_BackfillDeletionMarkers.ts";
import Migration0079 from "./Migrations/079_RetireIncompletePurgeJobs.ts";
import Migration0080 from "./Migrations/080_OrchestrationEventGaps.ts";
import Migration0081 from "./Migrations/081_ProjectionThreadOwnership.ts";
import Migration0082 from "./Migrations/082_ProjectionThreadTasksOwnership.ts";
import Migration0083 from "./Migrations/083_ProjectionThreadStateOwnership.ts";
import Migration0084 from "./Migrations/084_ProjectionThreadAttachmentOwnership.ts";
import Migration0085 from "./Migrations/085_ProjectionTurnsOwnership.ts";
import Migration0086 from "./Migrations/086_ThreadRuntimeOwnership.ts";
import Migration0087 from "./Migrations/087_ThreadAuxiliaryOwnership.ts";
import Migration0088 from "./Migrations/088_ProjectionThreadWatchesOwnership.ts";
import Migration0089 from "./Migrations/089_ThreadDelegationsOwnership.ts";
import Migration0090 from "./Migrations/090_ThreadLeaseAndLivenessOwnership.ts";
import Migration0091 from "./Migrations/091_ProviderTurnLivenessOwnership.ts";
import Migration0092 from "./Migrations/092_AutomationThreadOwnership.ts";
import Migration0093 from "./Migrations/093_ThreadIdentityOwnership.ts";
import Migration0094 from "./Migrations/094_RepairProjectionThreadSessionIdentity.ts";
import Migration0095 from "./Migrations/095_RepairProjectionThreadProposedPlanImplementation.ts";
import Migration0096 from "./Migrations/096_RepairOrchestrationThreadIdentityIndependence.ts";
import Migration0097 from "./Migrations/097_ThreadRetentionFinitePolicies.ts";
import Migration0098 from "./Migrations/098_ThreadDelegationReservationOwnership.ts";
import Migration0099 from "./Migrations/099_ParentDeletionUpdateGuard.ts";
import Migration0100 from "./Migrations/100_ProviderTurnLivenessSessionEpoch.ts";
import Migration0101 from "./Migrations/101_ProviderRuntimeEpochAndTurnControl.ts";
import Migration0102 from "./Migrations/102_ThreadRuntimeLeaseTerminalMultiplicity.ts";
import Migration0103 from "./Migrations/103_ProviderSessionRuntimeReconciliationIndex.ts";
import Migration0104 from "./Migrations/104_ThreadIdentityLatestMaterialization.ts";
import Migration0105 from "./Migrations/105_CommandReceiptRejectionReason.ts";
import Migration0106 from "./Migrations/106_CommandReceiptPayloadDigest.ts";
import Migration0107 from "./Migrations/107_OrchestrationBootstrapRecipes.ts";
import Migration0108 from "./Migrations/108_DirectResourceCleanupPlans.ts";
import Migration0109 from "./Migrations/109_RepairOrchestrationEventIdSequences.ts";

export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "ProjectionThreadsParentThread", Migration0020],
  [21, "BackfillProjectionThreadShellSummary", Migration0021],
  [22, "ProjectionProjectsNullableWorkspaceRoot", Migration0022],
  [23, "CleanupInvalidProjectionPendingApprovals", Migration0023],
  [24, "ProjectionThreadSessionReason", Migration0024],
  [25, "ProjectionThreadsDeletingAt", Migration0025],
  [26, "ProjectionProjectsDeletingAt", Migration0026],
  [27, "ProjectionThreadMessageReplies", Migration0027],
  [28, "ExecutionTargets", Migration0028],
  [29, "ProviderRuntimeWorkspaceExecutionTargets", Migration0029],
  [30, "ProjectionRuntimeWorkspaceExecutionTargets", Migration0030],
  [31, "ProjectionNotes", Migration0031],
  [32, "AutomationSchedules", Migration0032],
  [33, "AutomationSchedulesBackfillColumns", Migration0033],
  [34, "AutomationSchedulesBackfillProjectId", Migration0034],
  [35, "AutomationRunOccurrences", Migration0035],
  [36, "AutomationRunTerminalEventId", Migration0036],
  [37, "ProjectionThreadWatches", Migration0037],
  [38, "ProjectionThreadsElevatorSummary", Migration0038],
  [39, "LearningJobs", Migration0039],
  [40, "SkillChangeProposals", Migration0040],
  [41, "LearningJobMemoryUserMessageCount", Migration0041],
  [42, "ProjectionThreadsPurpose", Migration0042],
  [43, "ProjectionThreadActivityUsageIndex", Migration0043],
  [44, "ProjectionUsageContributions", Migration0044],
  [45, "RepairProjectionUsageContributions", Migration0045],
  [46, "ProjectionThreadTasks", Migration0046],
  [47, "ProviderSelectionQuarantine", Migration0047],
  [48, "ThreadDelegations", Migration0048],
  [49, "ProjectionThreadsParentProject", Migration0049],
  [50, "ProjectionThreadWatchesUniqueActive", Migration0050],
  [51, "PurgeJobs", Migration0051],
  [52, "ProjectionThreadsPinnedAt", Migration0052],
  [53, "ProjectionCatalogIndexes", Migration0053],
  [54, "ProjectionThreadDetailIndexes", Migration0054],
  [55, "ProjectionPendingUserInputs", Migration0055],
  [56, "ProjectionBaselines", Migration0056],
  [57, "OrchestrationThreadIdentity", Migration0057],
  [58, "RepairProjectionNotes", Migration0058],
  [59, "ResumablePurgeBaseline", Migration0059],
  [60, "ProjectionCatalogUserMessageIndex", Migration0060],
  [61, "ProjectionChatsCreatedIndex", Migration0061],
  [62, "ProjectionThreadQueuedPrompts", Migration0062],
  [63, "ThreadRetentionFoundation", Migration0063],
  [64, "CheckpointRetentionIdentity", Migration0064],
  [65, "ThreadRetentionSecurityHardening", Migration0065],
  [66, "PurgeExecutionLeases", Migration0066],
  [67, "ThreadRetentionPolicyAuthority", Migration0067],
  [68, "ThreadRetentionSafetyRecovery", Migration0068],
  [69, "ThreadRetentionManualRecovery", Migration0069],
  [70, "ThreadAttachmentReferences", Migration0070],
  [71, "ProjectionThreadPendingInterruptFlushIntent", Migration0071],
  [72, "ProjectionProjectCatalogScopeIndexes", Migration0072],
  [73, "ProviderTurnLiveness", Migration0073],
  [74, "ThreadRetentionQueuedRuns", Migration0074],
  [76, "ThreadRetentionItemRetries", Migration0076],
  [77, "AutomationOwnedThreads", Migration0077],
  [78, "BackfillDeletionMarkers", Migration0078],
  [79, "RetireIncompletePurgeJobs", Migration0079],
  [80, "OrchestrationEventGaps", Migration0080],
  [81, "ProjectionThreadOwnership", Migration0081],
  [82, "ProjectionThreadTasksOwnership", Migration0082],
  [83, "ProjectionThreadStateOwnership", Migration0083],
  [84, "ProjectionThreadAttachmentOwnership", Migration0084],
  [85, "ProjectionTurnsOwnership", Migration0085],
  [86, "ThreadRuntimeOwnership", Migration0086],
  [87, "ThreadAuxiliaryOwnership", Migration0087],
  [88, "ProjectionThreadWatchesOwnership", Migration0088],
  [89, "ThreadDelegationsOwnership", Migration0089],
  [90, "ThreadLeaseAndLivenessOwnership", Migration0090],
  [91, "ProviderTurnLivenessOwnership", Migration0091],
  [92, "AutomationThreadOwnership", Migration0092],
  [93, "ThreadIdentityOwnership", Migration0093],
  [94, "RepairProjectionThreadSessionIdentity", Migration0094],
  [95, "RepairProjectionThreadProposedPlanImplementation", Migration0095],
  [96, "RepairOrchestrationThreadIdentityIndependence", Migration0096],
  [97, "ThreadRetentionFinitePolicies", Migration0097],
  [98, "ThreadDelegationReservationOwnership", Migration0098],
  [99, "ParentDeletionUpdateGuard", Migration0099],
  [100, "ProviderTurnLivenessSessionEpoch", Migration0100],
  [101, "ProviderRuntimeEpochAndTurnControl", Migration0101],
  [102, "ThreadRuntimeLeaseTerminalMultiplicity", Migration0102],
  [103, "ProviderSessionRuntimeReconciliationIndex", Migration0103],
  [104, "ThreadIdentityLatestMaterialization", Migration0104],
  [105, "CommandReceiptRejectionReason", Migration0105],
  [106, "CommandReceiptPayloadDigest", Migration0106],
  [107, "OrchestrationBootstrapRecipes", Migration0107],
  [108, "DirectResourceCleanupPlans", Migration0108],
  [109, "RepairOrchestrationEventIdSequences", Migration0109],
] as const;

export const latestMigrationId = migrationEntries.at(-1)?.[0] ?? 0;
export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );
const run = Migrator.make({});
export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* Effect.log(
    toMigrationInclusive === undefined
      ? "Running all migrations..."
      : `Running migrations 1 through ${toMigrationInclusive}...`,
  );
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  yield* Effect.log("Migrations ran successfully").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});
export const MigrationsLive = Layer.effectDiscard(runMigrations());
