import type { GitStatusResult } from "@bigbud/contracts";
import { CloudUploadIcon, DownloadIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { GitSyncAction, GitSyncIssue } from "./GitPanelSyncPrompt";

export function actionsForStatus(status: GitStatusResult | null): GitSyncAction[] {
  if (!status) return ["fetch"];
  const actions: GitSyncAction[] = [];
  if (status.behindCount > 0) actions.push("pull");
  if (status.aheadCount > 0) actions.push("push");
  if (actions.length === 0) actions.push("fetch");
  return actions;
}

export interface GitPanelSyncActionButton {
  action: GitSyncAction;
  label: string;
  issue: GitSyncIssue | null;
}

export function GitPanelSyncActionButtons({
  actions,
  disabled,
  onAction,
}: {
  actions: GitPanelSyncActionButton[];
  disabled: boolean;
  onAction: (action: GitSyncAction) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {actions.map((entry, index) => (
        <Button
          key={entry.action}
          size="xs"
          variant={index === 0 && actions.length > 1 ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onAction(entry.action)}
          title={entry.issue ? "Review this Git issue" : undefined}
        >
          {entry.action === "push" ? (
            <CloudUploadIcon aria-hidden="true" className="size-3.5" />
          ) : (
            <DownloadIcon aria-hidden="true" className="size-3.5" />
          )}
          {entry.label}
        </Button>
      ))}
    </div>
  );
}
