import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention";
import { CircleAlertIcon, CircleCheckIcon, Clock3Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  formatRetentionCutoff,
  getRetentionRunStatusMessage,
  isActiveRetentionRun,
} from "./ThreadRetentionSettingsSection.logic";

interface ThreadRetentionRunStatusProps {
  readonly run: ServerThreadRetentionRun | null;
  readonly pollingError: string | null;
  readonly onRetry: () => void;
  readonly availability?: "available" | "disabled" | "loading";
}

export function ThreadRetentionRunStatus({
  run,
  pollingError,
  onRetry,
  availability = "available",
}: ThreadRetentionRunStatusProps) {
  if (!run && !pollingError && availability !== "disabled") return null;

  const failed = run?.status === "failed" || run?.status === "completed_with_failures";
  const active = run ? isActiveRetentionRun(run) : false;
  const StateIcon =
    failed || pollingError ? CircleAlertIcon : active ? Clock3Icon : CircleCheckIcon;

  return (
    <div
      role={pollingError ? "alert" : "status"}
      aria-live={pollingError ? "assertive" : "polite"}
      aria-atomic="true"
      className="space-y-2 text-xs text-muted-foreground"
    >
      {availability === "disabled" ? (
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Automatic thread cleanup is disabled by the server administrator.
        </p>
      ) : null}
      {run ? (
        <>
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <StateIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {getRetentionRunStatusMessage(run)}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <div>
              <dt className="inline">Accepted: </dt>
              <dd className="inline text-foreground">{formatRetentionCutoff(run.createdAt)}</dd>
            </div>
            <div>
              <dt className="inline">Eligible: </dt>
              <dd className="inline text-foreground">{run.eligibleCount}</dd>
            </div>
            <div>
              <dt className="inline">Selected: </dt>
              <dd className="inline text-foreground">{run.selectedCount}</dd>
            </div>
            <div>
              <dt className="inline">Requested: </dt>
              <dd className="inline text-foreground">{run.requestedCount}</dd>
            </div>
            <div>
              <dt className="inline">Completed: </dt>
              <dd className="inline text-foreground">{run.completedCount}</dd>
            </div>
            <div>
              <dt className="inline">Skipped: </dt>
              <dd className="inline text-foreground">{run.skippedCount}</dd>
            </div>
            <div>
              <dt className="inline">Failed: </dt>
              <dd className="inline text-foreground">{run.failedCount}</dd>
            </div>
          </dl>
          <p>
            Cutoff: {formatRetentionCutoff(run.cutoffAt)}. Run ID: {run.runId}.
          </p>
          {run.errorMessage ? (
            <p className="font-medium text-foreground">{run.errorMessage}</p>
          ) : null}
        </>
      ) : null}
      {pollingError ? (
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
          <p className="font-medium text-foreground">{pollingError}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon aria-hidden="true" />
            Retry updates
          </Button>
        </div>
      ) : null}
    </div>
  );
}
