import { PanelEmptyState } from "../PanelEmptyState";

/** Normal empty state for a workspace folder outside any git repository. */
export function GitPanelNotRepository() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-shell-pane-fill)]">
      <PanelEmptyState testId="git-panel-not-repo">
        This folder isn&apos;t a git repository.
      </PanelEmptyState>
    </div>
  );
}
