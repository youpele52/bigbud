import type { GitStatusResult, ThreadId } from "@bigbud/contracts";
import { CloudUploadIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { DefaultBranchDialog } from "~/components/git/GitActionsControl.defaultBranchDialog";
import {
  buildMenuItems,
  resolveDefaultBranchActionDialogCopy,
} from "~/components/git/GitActionsControl.logic";
import { useGitActionRunner } from "~/components/git/GitActionsControl.runner";
import { getGitPanelPushLabel } from "./GitPanelPushAction.logic";

interface GitPanelPushActionProps {
  activeThreadId: ThreadId | null | undefined;
  cwd: string;
  executionTargetId?: string | undefined;
  gitStatus: GitStatusResult;
}

export function GitPanelPushAction({
  activeThreadId,
  cwd,
  executionTargetId,
  gitStatus,
}: GitPanelPushActionProps) {
  const [pendingDefaultBranchPush, setPendingDefaultBranchPush] = useState<string | null>(null);
  const { isRunning, runGitActionWithToast } = useGitActionRunner({
    gitCwd: cwd,
    executionTargetId,
    activeThreadId: activeThreadId ?? null,
    isDefaultBranch: gitStatus.isDefaultBranch,
    gitStatusForActions: gitStatus,
    threadToastData: activeThreadId ? { threadId: activeThreadId } : undefined,
    callbacks: {
      onRequestDefaultBranchConfirmation: ({ action, branchName }) => {
        if (action === "push") {
          setPendingDefaultBranchPush(branchName);
        }
      },
    },
  });
  const pushMenuItem = buildMenuItems(gitStatus, isRunning, gitStatus.hasOriginRemote).find(
    (item) => item.id === "push",
  );

  if (gitStatus.aheadCount === 0 || !pushMenuItem) {
    return null;
  }

  const runPush = ({ featureBranch = false, skipDefaultBranchPrompt = false } = {}) => {
    setPendingDefaultBranchPush(null);
    void runGitActionWithToast({
      action: "push",
      featureBranch,
      skipDefaultBranchPrompt,
    });
  };
  const defaultBranchCopy = pendingDefaultBranchPush
    ? resolveDefaultBranchActionDialogCopy({
        action: "push",
        branchName: pendingDefaultBranchPush,
        includesCommit: false,
      })
    : null;

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={pushMenuItem.disabled}
        onClick={() => runPush()}
      >
        <CloudUploadIcon className="size-3.5" />
        {getGitPanelPushLabel(gitStatus.aheadCount)}
      </Button>
      <DefaultBranchDialog
        open={pendingDefaultBranchPush !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDefaultBranchPush(null);
        }}
        copy={defaultBranchCopy}
        onAbort={() => setPendingDefaultBranchPush(null)}
        onContinueOnDefaultBranch={() => runPush({ skipDefaultBranchPrompt: true })}
        onCheckoutFeatureBranch={() =>
          runPush({ featureBranch: true, skipDefaultBranchPrompt: true })
        }
      />
    </>
  );
}
