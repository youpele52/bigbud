import type { ThreadId } from "@bigbud/contracts";
import type { DefaultBranchConfirmableAction } from "./GitActionsControl.logic";
import { resolveDefaultBranchActionDialogCopy } from "./GitActionsControl.logic";

export interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

export interface GitActionsControlProps {
  gitCwd: string | null;
  isProjectThread?: boolean;
  executionTargetId?: string | undefined;
  activeThreadId: ThreadId | null;
  onOpenOrchestra?: (() => void) | undefined;
  onOpenSideChat?: (() => void) | undefined;
  sideChatDisabled?: boolean | undefined;
  planCardLabel?: string | undefined;
  planCardOpen?: boolean | undefined;
  onTogglePlanCard?: (() => void) | undefined;
  onOpenTerminal?: (() => void) | undefined;
}

export function resolvePendingDefaultBranchActionCopy(pending: PendingDefaultBranchAction | null) {
  if (!pending) return null;
  return resolveDefaultBranchActionDialogCopy({
    action: pending.action,
    branchName: pending.branchName,
    includesCommit: pending.includesCommit,
  });
}
