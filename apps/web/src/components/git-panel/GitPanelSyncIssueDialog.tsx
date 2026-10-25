import type { GitStatusResult } from "@bigbud/contracts";
import { AlertTriangleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import type {
  GitSyncAction,
  GitSyncIssue,
  GitSyncPromptPreference,
  GitSyncPromptOption,
} from "./GitPanelSyncPrompt";
import { formatGitSyncSummary, getGitSyncIssueOptions } from "./GitPanelSyncPrompt";

interface GitPanelSyncIssueDialogProps {
  open: boolean;
  action: GitSyncAction;
  issue: GitSyncIssue;
  cwd: string;
  executionTargetId?: string | undefined;
  status: GitStatusResult | null;
  error: string | null;
  hasActiveThread: boolean;
  onOpenChange: (open: boolean) => void;
  onPreparePrompt: (preference: GitSyncPromptPreference) => void;
}

function issueTitle(issue: GitSyncIssue): string {
  if (issue === "dirty_pull") return "Local changes block Pull";
  if (issue === "dirty_push") return "Local changes need attention";
  if (issue === "diverged") return "Branch has diverged from upstream";
  if (issue === "detached") return "This repository is on a detached HEAD";
  if (issue === "missing_upstream") return "The branch has no upstream";
  if (issue === "missing_remote") return "The remote could not be confirmed";
  if (issue === "status_unavailable") return "Git status could not be confirmed";
  return "The Git operation needs attention";
}

function issueDescription(issue: GitSyncIssue, action: GitSyncAction): string {
  if (issue === "dirty_pull") {
    return "Incoming commits may overlap with uncommitted work, so Pull was not attempted.";
  }
  if (issue === "dirty_push") {
    return "The worktree contains uncommitted changes. Review how to protect them before continuing.";
  }
  if (issue === "diverged") {
    return "Local and remote history both contain commits. Pull remains fast-forward-only, so no automatic merge or rebase was attempted.";
  }
  if (issue === "detached") return `${action} needs a named branch before it can proceed safely.`;
  if (issue === "missing_upstream") {
    return "The current branch is not tracking a remote branch, so the intended operation cannot be confirmed safely.";
  }
  if (issue === "missing_remote")
    return "Fetch needs an available origin remote before it can run.";
  if (issue === "status_unavailable")
    return "The latest repository state is unknown, so no synchronization change was attempted.";
  return `The ${action} operation did not complete. Review the details before trying again.`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/50 py-1.5 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="max-w-[65%] break-words text-right text-xs text-foreground">{value}</dd>
    </div>
  );
}

export function GitPanelSyncIssueDialog({
  open,
  action,
  issue,
  cwd,
  executionTargetId,
  status,
  error,
  hasActiveThread,
  onOpenChange,
  onPreparePrompt,
}: GitPanelSyncIssueDialogProps) {
  const options = getGitSyncIssueOptions(issue);
  const [preference, setPreference] = useState<GitSyncPromptPreference>("investigate");
  const selectedOption: GitSyncPromptOption =
    options.find((option) => option.value === preference) ?? options[0]!;

  useEffect(() => {
    if (open) setPreference("investigate");
  }, [issue, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3 pr-8">
            <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="min-w-0">
              <DialogTitle>{issueTitle(issue)}</DialogTitle>
              <DialogDescription>{issueDescription(issue, action)}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <dl className="rounded-xl border border-border/70 bg-muted/20 px-3 py-1">
            <Fact label="Workspace" value={cwd} />
            <Fact label="Execution target" value={executionTargetId ?? "local"} />
            <Fact label="Branch" value={status?.branch ?? "detached or unavailable"} />
            <Fact label="Synchronization" value={formatGitSyncSummary(status)} />
            <Fact
              label="Working tree"
              value={
                status?.hasWorkingTreeChanges
                  ? `${status.workingTree.files.length} changed files`
                  : status
                    ? "clean"
                    : "unknown"
              }
            />
            {error ? <Fact label="Latest error" value={error} /> : null}
          </dl>

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">How should the agent help?</p>
            <RadioGroup
              aria-label="Git issue resolution preference"
              value={preference}
              onValueChange={(value) => setPreference(value as GitSyncPromptPreference)}
            >
              {options.map((option) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 p-3 transition-colors hover:bg-muted/30 has-data-checked:border-primary/50 has-data-checked:bg-primary/5"
                  key={option.value}
                >
                  <Radio value={option.value} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Adds an editable prompt to the composer. Nothing is sent automatically.
            {!hasActiveThread ? " Select a chat before preparing a prompt." : ""}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Handle manually
          </Button>
          <Button
            size="sm"
            disabled={!hasActiveThread}
            onClick={() => onPreparePrompt(selectedOption.value)}
          >
            {selectedOption.ctaLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
