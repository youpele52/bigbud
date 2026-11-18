import { BigbudLogo } from "../sidebar/SidebarProjectItem";

/**
 * Normal empty state for a workspace folder outside any git repository: the bigbud mark centred
 * with a muted note at the bottom, matching the panel empty states such as "No completed turns yet."
 */
export function GitPanelNotRepository() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="git-panel-not-repo">
      <div className="flex flex-1 items-center justify-center">
        <BigbudLogo decorative className="h-7 text-muted-foreground/50" />
      </div>
      <p className="px-5 pb-6 text-center text-xs text-muted-foreground/70">
        This folder isn&apos;t a git repository.
      </p>
    </div>
  );
}
