import type {
  ServerThreadRetentionPreview,
  ThreadRetentionConsentTrigger,
} from "@bigbud/contracts/server/threadRetention";
import { AlertTriangleIcon, ShieldCheckIcon } from "lucide-react";

import {
  formatRetentionBytes,
  formatRetentionCutoff,
  formatRetentionExclusionReason,
} from "./ThreadRetentionSettingsSection.logic";

interface ThreadRetentionConfirmationContentProps {
  readonly preview: ServerThreadRetentionPreview | null;
  readonly trigger: ThreadRetentionConsentTrigger | null;
}

export function ThreadRetentionConfirmationContent({
  preview,
  trigger,
}: ThreadRetentionConfirmationContentProps) {
  return (
    <div className="space-y-3">
      {preview ? (
        <>
          {trigger === "policy-change" ? (
            <>
              <p>
                This preview found{" "}
                <strong className="text-foreground">{preview.eligibleCount}</strong> threads
                currently eligible for future retention. This policy change does not delete anything
                now; future runs recheck every safety rule.
              </p>
              <p className="font-medium text-foreground">
                Export or back up anything you need before enabling automatic retention.
              </p>
            </>
          ) : (
            <p>
              This preview found{" "}
              <strong className="text-foreground">{preview.eligibleCount}</strong> threads with no
              activity since {formatRetentionCutoff(preview.cutoffAt)}. Final selection rechecks
              every safety rule, so fewer threads may be deleted.
            </p>
          )}
          <div>
            <p className="font-medium text-foreground">Deletion includes</p>
            <p>
              Chat history, attachments, checkpoints and diffs, terminal/provider logs, and
              bigbud-managed worktrees.
            </p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
              Always preserved
            </p>
            <p>
              Pinned threads; active or running threads; queued threads; threads waiting for
              approval or input; watched threads; and delegated parent or child threads. Project
              folders, source files, and other user-created files outside bigbud-managed storage are
              not deleted.
            </p>
          </div>
          <div aria-label="Preview estimates">
            <p className="font-medium text-foreground">Preview estimates</p>
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
                This bounded preview is partial. Additional managed resources may be deleted.
              </p>
            ) : null}
          </div>
          <div>
            <p className="font-medium text-foreground">Excluded by the current preview</p>
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
          {preview.maintenanceState !== "available" ? (
            <p className="font-medium text-foreground">
              Retention maintenance is {preview.maintenanceState}. Wait for the current run to
              finish before starting another manual run.
            </p>
          ) : null}
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
          ? "Future retention runs permanently delete eligible bigbud data and cannot be undone."
          : "This permanently deletes the listed bigbud data and cannot be undone. Export or back up anything you need first."}
      </p>
    </div>
  );
}
