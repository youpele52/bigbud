import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "../ui/progress";

/** Shared inline download presentation; each caller owns its job identity, placement, and actions. */
export function DownloadProgress({
  label,
  percent,
  detail,
  action,
}: {
  label: string;
  percent: number | null;
  detail?: string | undefined;
  action?: ReactNode;
}) {
  const value =
    percent === null || !Number.isFinite(percent) ? null : Math.min(100, Math.max(0, percent));
  return (
    <Progress
      aria-label={label}
      aria-valuetext={value === null ? label : `Download progress: ${Math.round(value)}%`}
      value={value}
      className="group/download gap-1.5 px-2 py-1"
    >
      <div className="flex items-center gap-2">
        <DownloadIcon className="size-3 animate-breathe text-info" />
        <ProgressLabel className="text-muted-foreground transition-colors group-hover/download:text-foreground group-focus-within/download:text-foreground">
          {label}
        </ProgressLabel>
        <ProgressValue className="ml-auto transition-colors group-hover/download:text-foreground group-focus-within/download:text-foreground">
          {(_, progress) => (progress === null ? "…" : `${Math.round(progress)}%`)}
        </ProgressValue>
        {action}
      </div>
      <ProgressTrack>
        <ProgressIndicator className="bg-info" />
      </ProgressTrack>
      {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
    </Progress>
  );
}
