import type {
  ServerThreadRetentionPreview,
  ThreadRetentionConsentTrigger,
} from "@bigbud/contracts/server/threadRetention";
import { AlertTriangleIcon, ShieldCheckIcon } from "lucide-react";

import {
  formatRetentionBytes,
  formatRetentionCutoff,
  formatRetentionExclusionReason,
  getRetentionMaintenanceMessage,
} from "./ThreadRetentionSettingsSection.logic";

interface ThreadRetentionConfirmationContentProps {
  readonly preview: ServerThreadRetentionPreview | null;
  readonly trigger: ThreadRetentionConsentTrigger | null;
}

export function ThreadRetentionConfirmationContent({
  preview,
  trigger,
}: ThreadRetentionConfirmationContentProps) {
  const maintenanceMessage = preview
    ? getRetentionMaintenanceMessage(preview.maintenanceState)
    : null;

  return (
    <div className="space-y-3">
      {preview ? (
        <>
          {trigger === "policy-change" ? (
            <>
              <p>
                This preview found{" "}
                <strong className="text-foreground">{preview.eligibleCount}</strong> threads
                currently eligible for future cleanup. This setting change does not delete anything
                now; daily checks recheck every safety rule.
              </p>
              <p className="font-medium text-foreground">
                Export or back up anything you need before enabling automatic thread cleanup.
              </p>
            </>
          ) : (
            <p>
              <strong className="text-foreground">{preview.eligibleCount}</strong> threads have been
              inactive since {formatRetentionCutoff(preview.cutoffAt)} and are currently eligible
              for deletion. Before deleting, bigbud checks each thread again for safety, so the
              final safety checks may skip a subtree that became active.
            </p>
          )}
          {maintenanceMessage ? <p>{maintenanceMessage}</p> : null}
          <div>
            <p className="font-medium text-foreground">Deletion includes</p>
            <p>
              bigbud removes each selected thread subtree from its current local views and cleans up
              associated bigbud-managed local resources, including attachments, checkpoints and
              diffs, terminal and provider logs, and managed worktrees. Child threads are deleted
              with their parent.
            </p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
              Always preserved
            </p>
            <p>
              Pinned and active or running thread subtrees are never deleted. Your project folders,
              source files, and other files outside bigbud-managed storage are also kept.
            </p>
          </div>
          <div aria-label="Preview estimates">
            <p className="font-medium text-foreground">Estimated data to be deleted</p>
            <ul className="list-disc pl-5">
              <li>
                {preview.resourceEstimateComplete ? "" : "At least "}
                {preview.estimatedResourceCount} known resources
              </li>
              <li>
                {preview.attachmentEstimateComplete ? "" : "At least "}
                {preview.estimatedAttachmentCount} known attachments
              </li>
              <li>
                {preview.bytesEstimateComplete ? "" : "At least "}
                {formatRetentionBytes(preview.estimatedKnownBytes)} known size
              </li>
            </ul>
            {!preview.resourceEstimateComplete ||
            !preview.attachmentEstimateComplete ||
            !preview.bytesEstimateComplete ? (
              <p className="font-medium text-foreground">
                This is an estimate. Cleanup may find additional bigbud-managed resources when it
                runs.
              </p>
            ) : null}
          </div>
          <div>
            <p className="font-medium text-foreground">Not included in this cleanup</p>
            <p>
              Provider-remote conversations are not deleted. Cleanup also does not claim to erase
              all local canonical history or retained baselines.
            </p>
            {preview.exclusionCounts.length > 0 ? (
              <ul className="list-disc pl-5">
                {preview.exclusionCounts.map((exclusion) => (
                  <li key={exclusion.reason}>
                    {formatRetentionExclusionReason(exclusion.reason)}: {exclusion.count}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No counted exclusions were returned. Final safety checks still apply.</p>
            )}
          </div>
          {preview.warnings.length > 0 ? (
            <div role="alert" className="font-medium text-foreground">
              <p>Preview warnings</p>
              <ul className="list-disc pl-5">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p role="status" aria-live="polite">
          Preparing a server-authoritative preview…
        </p>
      )}
      <p className="flex items-start gap-2 font-medium text-destructive">
        <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {trigger === "policy-change"
          ? "Future cleanup removes eligible local thread subtrees and managed resources. Export or back up anything you need first."
          : "This cleanup removes the listed local thread subtrees and managed resources. Export or back up anything you need first."}
      </p>
    </div>
  );
}
