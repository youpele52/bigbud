import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import {
  OrganizationMigrationContext,
  classifyOrganizationInstallation,
} from "./OrganizationMigrationContext.ts";

import {
  type MigrationProgressListener,
  makeMigrationProgressTracker,
  readLatestAppliedMigrationId,
} from "./MigrationProgress.ts";

import { baseMigrationEntries } from "./Migrations.base.ts";
import Migration0101 from "./Migrations/101_ProviderRuntimeEpochAndTurnControl.ts";
import Migration0102 from "./Migrations/102_ThreadRuntimeLeaseTerminalMultiplicity.ts";
import Migration0103 from "./Migrations/103_ProviderSessionRuntimeReconciliationIndex.ts";
import Migration0104 from "./Migrations/104_ThreadIdentityLatestMaterialization.ts";
import Migration0105 from "./Migrations/105_CommandReceiptRejectionReason.ts";
import Migration0106 from "./Migrations/106_CommandReceiptPayloadDigest.ts";
import Migration0107 from "./Migrations/107_OrchestrationBootstrapRecipes.ts";
import Migration0108 from "./Migrations/108_DirectResourceCleanupPlans.ts";
import Migration0109 from "./Migrations/109_RepairOrchestrationEventIdSequences.ts";
import Migration0110 from "./Migrations/110_DirectResourceCleanupWorktrees.ts";
import Migration0111 from "./Migrations/111_RemoteAgentRuntimeBindings.ts";
import Migration0112 from "./Migrations/112_RemoteAgentReplayFence.ts";
import Migration0113 from "./Migrations/113_RemoteAgentRestartRequests.ts";
import Migration0114 from "./Migrations/114_OrchestrationBootstrapSubmissionRecipes.ts";
import Migration0115 from "./Migrations/115_ProjectDeletionOwnership.ts";
import Migration0116 from "./Migrations/116_RepairThreadRetentionFinitePolicies.ts";
import Migration0118 from "./Migrations/118_LearningReviewRecovery.ts";
import Migration0119 from "./Migrations/119_RepairLearningActivityLeases.ts";
import Migration0117 from "./Migrations/117_RepairThreadRetentionItemIndependence.ts";
import Migration0120 from "./Migrations/120_ProjectionMessageSearch.ts";
import Migration0122 from "./Migrations/122_ProjectionThreadMessageOrigins.ts";
import Migration0121 from "./Migrations/121_ThreadRetentionSelectionMode.ts";
import Migration0123 from "./Migrations/123_ProviderTurnAdmissions.ts";
import Migration0124 from "./Migrations/124_ProviderTurnAdmissionOutcomes.ts";
import Migration0125 from "./Migrations/125_ProviderTurnAdmissionPayloads.ts";
import Migration0126 from "./Migrations/126_LearningMemoryApplications.ts";
import Migration0127 from "./Migrations/127_OpencodeV2SharedBindings.ts";
import Migration0128 from "./Migrations/128_ProjectionThreadsForkOrigin.ts";
import Migration0129 from "./Migrations/129_RepairDirectResourceCleanupRequests.ts";
import Migration0130 from "./Migrations/130_WorktreeOperations.ts";
import Migration0131 from "./Migrations/131_WorktreeProviderRelocations.ts";
import Migration0132 from "./Migrations/132_RepairWorktreeOperationSchema.ts";
import Migration0133 from "./Migrations/133_UsageAccountingV2.ts";
import Migration0134 from "./Migrations/134_UsageCodexRetirementGuards.ts";
import Migration0135 from "./Migrations/135_ProjectionSessionRetainedFamily.ts";
import Migration0136 from "./Migrations/136_ProjectionThreadPendingTurnStart.ts";
import Migration0137 from "./Migrations/137_ThreadRecoveryIntents.ts";
import Migration0138 from "./Migrations/138_ProjectionThreadRecovery.ts";
import Migration0139 from "./Migrations/139_CommandReceiptQueueDecision.ts";
import Migration0140 from "./Migrations/140_MuseSessionBindings.ts";
import Migration0141 from "./Migrations/141_ProjectionThreadOrganization.ts";
import Migration0142 from "./Migrations/142_ProjectionThreadOrganizationIndex.ts";
import Migration0143 from "./Migrations/143_ProjectionThreadSnoozeIndex.ts";
import Migration0144 from "./Migrations/144_RetiredTerminalBackend.ts";
import Migration0145 from "./Migrations/145_ProjectWorkspaceOwnership.ts";
import Migration0146 from "./Migrations/146_ThreadOrganizationRuntime.ts";
import Migration0147 from "./Migrations/147_ProjectWorkspaceNativeTransitions.ts";
import Migration0148 from "./Migrations/148_ThreadOrganizationAging.ts";
import Migration0149 from "./Migrations/149_ThreadOrganizationOperations.ts";
import Migration0150 from "./Migrations/150_ThreadOrganizationFacts.ts";
import Migration0151 from "./Migrations/151_ThreadOrganizationAttention.ts";
import Migration0152 from "./Migrations/152_ProjectionBaselineRows.ts";
import Migration0153 from "./Migrations/153_ThreadRetentionRunExclusionCounts.ts";
import Migration0154 from "./Migrations/154_ProjectionThreadSidebarPaging.ts";
import Migration0155 from "./Migrations/155_ThreadRetentionLeaseExpiry.ts";
import Migration0156 from "./Migrations/156_EventLogMaintenance.ts";
import Migration0157 from "./Migrations/157_ProjectionTurnUsageAttribution.ts";
import Migration0158 from "./Migrations/158_EventLogMaintenanceOrphanClaims.ts";
import Migration0159 from "./Migrations/159_EventLogSequenceClock.ts";
import Migration0160 from "./Migrations/160_ThreadMetadataGeneration.ts";
import Migration0161 from "./Migrations/161_ThreadMetadataEvidenceIndex.ts";
import Migration0162 from "./Migrations/162_ThreadMetadataModelBinding.ts";
import Migration0163 from "./Migrations/163_ThreadMetadataNativeReceipts.ts";
import Migration0164 from "./Migrations/164_ThreadMetadataConfigurationEpoch.ts";
import Migration0165 from "./Migrations/165_ThreadMetadataNativeRequests.ts";
import Migration0166 from "./Migrations/166_ThreadMetadataWarningFailures.ts";
import Migration0167 from "./Migrations/167_ThreadMetadataDeadlineCancellation.ts";

import Migration0171 from "./Migrations/171_ThreadMetadataLegacyClaimBoundary.ts";

import Migration0172 from "./Migrations/172_ThreadMetadataPurgedIdentityBoundary.ts";

export const migrationEntries = [
  ...baseMigrationEntries,
  [101, "ProviderRuntimeEpochAndTurnControl", Migration0101],
  [102, "ThreadRuntimeLeaseTerminalMultiplicity", Migration0102],
  [103, "ProviderSessionRuntimeReconciliationIndex", Migration0103],
  [104, "ThreadIdentityLatestMaterialization", Migration0104],
  [105, "CommandReceiptRejectionReason", Migration0105],
  [106, "CommandReceiptPayloadDigest", Migration0106],
  [107, "OrchestrationBootstrapRecipes", Migration0107],
  [108, "DirectResourceCleanupPlans", Migration0108],
  [109, "RepairOrchestrationEventIdSequences", Migration0109],
  [110, "DirectResourceCleanupWorktrees", Migration0110],
  [111, "RemoteAgentRuntimeBindings", Migration0111],
  [112, "RemoteAgentReplayFence", Migration0112],
  [113, "RemoteAgentRestartRequests", Migration0113],
  [114, "OrchestrationBootstrapSubmissionRecipes", Migration0114],
  [115, "ProjectDeletionOwnership", Migration0115],
  [116, "RepairThreadRetentionFinitePolicies", Migration0116],
  [117, "RepairThreadRetentionItemIndependence", Migration0117],
  [118, "LearningReviewRecovery", Migration0118],
  [119, "RepairLearningActivityLeases", Migration0119],
  [120, "ProjectionMessageSearch", Migration0120],
  [121, "ThreadRetentionSelectionMode", Migration0121],
  [122, "ProjectionThreadMessageOrigins", Migration0122],
  [123, "ProviderTurnAdmissions", Migration0123],
  [124, "ProviderTurnAdmissionOutcomes", Migration0124],
  [125, "ProviderTurnAdmissionPayloads", Migration0125],
  [126, "LearningMemoryApplications", Migration0126],
  [127, "OpencodeV2SharedBindings", Migration0127],
  [128, "ProjectionThreadsForkOrigin", Migration0128],
  [129, "RepairDirectResourceCleanupRequests", Migration0129],
  [130, "WorktreeOperations", Migration0130],
  [131, "WorktreeProviderRelocations", Migration0131],
  [132, "RepairWorktreeOperationSchema", Migration0132],
  [133, "UsageAccountingV2", Migration0133],
  [134, "UsageCodexRetirementGuards", Migration0134],
  [135, "ProjectionSessionRetainedFamily", Migration0135],
  [136, "ProjectionThreadPendingTurnStart", Migration0136],
  [137, "ThreadRecoveryIntents", Migration0137],
  [138, "ProjectionThreadRecovery", Migration0138],
  [139, "CommandReceiptQueueDecision", Migration0139],
  [140, "MuseSessionBindings", Migration0140],
  [141, "ProjectionThreadOrganization", Migration0141],
  [142, "ProjectionThreadOrganizationIndex", Migration0142],
  [143, "ProjectionThreadSnoozeIndex", Migration0143],
  [144, "RetiredTerminalBackend", Migration0144],
  [145, "ProjectWorkspaceOwnership", Migration0145],
  [146, "ThreadOrganizationRuntime", Migration0146],
  [147, "ProjectWorkspaceNativeTransitions", Migration0147],
  [148, "ThreadOrganizationAging", Migration0148],
  [149, "ThreadOrganizationOperations", Migration0149],
  [150, "ThreadOrganizationFacts", Migration0150],
  [151, "ThreadOrganizationAttention", Migration0151],
  [152, "ProjectionBaselineRows", Migration0152],
  [153, "ThreadRetentionRunExclusionCounts", Migration0153],
  [154, "ProjectionThreadSidebarPaging", Migration0154],
  [155, "ThreadRetentionLeaseExpiry", Migration0155],
  [156, "EventLogMaintenance", Migration0156],
  [157, "ProjectionTurnUsageAttribution", Migration0157],
  [158, "EventLogMaintenanceOrphanClaims", Migration0158],
  [159, "EventLogSequenceClock", Migration0159],
  [160, "ThreadMetadataGeneration", Migration0160],
  [161, "ThreadMetadataEvidenceIndex", Migration0161],
  [162, "ThreadMetadataModelBinding", Migration0162],
  [163, "ThreadMetadataNativeReceipts", Migration0163],
  [164, "ThreadMetadataConfigurationEpoch", Migration0164],
  [165, "ThreadMetadataNativeRequests", Migration0165],
  [166, "ThreadMetadataWarningFailures", Migration0166],
  [167, "ThreadMetadataDeadlineCancellation", Migration0167],
  [171, "ThreadMetadataLegacyClaimBoundary", Migration0171],
  [172, "ThreadMetadataPurgedIdentityBoundary", Migration0172],
] as const;

export const latestMigrationId = migrationEntries.at(-1)?.[0] ?? 0;
type MigrationEntry = (typeof migrationEntries)[number];
type MigrationWrapper = (
  entry: MigrationEntry,
) => Effect.Effect<void, Effect.Error<MigrationEntry[2]>, Effect.Services<MigrationEntry[2]>>;
const selectMigrationEntries = (throughId?: number) =>
  migrationEntries.filter(([id]) => throughId === undefined || id <= throughId);
export const makeMigrationLoader = (throughId?: number, wrap?: MigrationWrapper) =>
  Migrator.fromRecord(
    Object.fromEntries(
      selectMigrationEntries(throughId).map((entry) => [
        `${entry[0]}_${entry[1]}`,
        wrap ? wrap(entry) : entry[2],
      ]),
    ),
  );
const run = Migrator.make({});
export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
  /** Receives whole-run progress as an integer percent while pending migrations run. */
  readonly onProgress?: MigrationProgressListener | undefined;
}
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
  onProgress,
}: RunMigrationsOptions = {}) {
  yield* Effect.log(
    toMigrationInclusive === undefined
      ? "Running all migrations..."
      : `Running migrations 1 through ${toMigrationInclusive}...`,
  );
  let wrap: MigrationWrapper | undefined;
  if (onProgress) {
    const latestApplied = yield* readLatestAppliedMigrationId();
    const pending = selectMigrationEntries(toMigrationInclusive)
      .filter(([id]) => id > latestApplied)
      .map(([id]) => id);
    // A fresh database has nothing to upgrade, so it reports no progress.
    if (latestApplied > 0 && pending.length > 0) {
      const tracker = makeMigrationProgressTracker(pending.length, onProgress);
      tracker.start();
      wrap = (entry) => {
        const index = pending.indexOf(entry[0]);
        return index < 0 ? entry[2] : tracker.wrap(index, entry[2]);
      };
    }
  }
  const newInstallation = yield* classifyOrganizationInstallation;
  const executedMigrations = yield* run({
    loader: makeMigrationLoader(toMigrationInclusive, wrap),
  }).pipe(Effect.provideService(OrganizationMigrationContext, { newInstallation }));
  yield* Effect.log("Migrations ran successfully").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});
export const MigrationsLive = Layer.effectDiscard(runMigrations());
