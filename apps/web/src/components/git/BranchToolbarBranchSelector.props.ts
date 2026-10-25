import type { EnvMode } from "./BranchToolbar.logic";

export interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string | null;
  executionTargetId?: string | undefined;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  workspaceLocked?: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => Promise<void> | void;
  onSelectExistingWorktree: (path: string) => Promise<void>;
  onCreateWorktreeRequest?: () => void;
  onWorktreeOperationsRequest?: () => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}
