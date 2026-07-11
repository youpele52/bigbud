import { useEffect } from "react";

import { useBrowserPanelStore } from "~/stores/browser/browser.store";

const HANDOFF_VISIBLE_MS = 3_000;

interface BrowserAgentStatusProps {
  tabId: string;
  controlled: boolean;
  handoff: { readonly leaseId: string; readonly releasedAt: number } | undefined;
}

export function BrowserAgentStatus({ tabId, controlled, handoff }: BrowserAgentStatusProps) {
  const clearAgentHandoff = useBrowserPanelStore((state) => state.clearAgentHandoff);

  useEffect(() => {
    if (!handoff || controlled) return;
    const remainingMs = Math.max(0, handoff.releasedAt + HANDOFF_VISIBLE_MS - Date.now());
    const timeout = window.setTimeout(() => clearAgentHandoff(tabId, handoff.leaseId), remainingMs);
    return () => window.clearTimeout(timeout);
  }, [clearAgentHandoff, controlled, handoff, tabId]);

  if (controlled) {
    return (
      <div className="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
        Agent controlling this tab
      </div>
    );
  }
  if (!handoff) return null;
  return (
    <div className="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
      Agent finished — tab returned to you
    </div>
  );
}
