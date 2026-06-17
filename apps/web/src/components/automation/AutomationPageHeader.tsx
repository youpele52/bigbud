import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { truncateThreadName } from "../sidebar/Sidebar.logic";

function ContentPanelHeaderBar(input: { readonly actions?: ReactNode; readonly title: ReactNode }) {
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden sm:gap-3">
        {input.title}
      </div>
      {input.actions ? (
        <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
          {input.actions}
        </div>
      ) : null}
    </div>
  );
}

interface AutomationListPageHeaderProps {
  readonly actions?: ReactNode;
}

export function AutomationListPageHeader({ actions }: AutomationListPageHeaderProps) {
  return (
    <ContentPanelHeaderBar
      actions={actions}
      title={
        <h2 className="min-w-0 shrink truncate text-sm font-medium text-foreground">Automations</h2>
      }
    />
  );
}

interface AutomationDetailPageHeaderProps {
  readonly actions?: ReactNode;
  readonly title: string;
}

export function AutomationDetailPageHeader({ actions, title }: AutomationDetailPageHeaderProps) {
  return (
    <ContentPanelHeaderBar
      actions={actions}
      title={
        <h2 className="min-w-0 shrink truncate text-sm font-medium" title={title}>
          <Link
            to="/automations"
            className="text-foreground transition-colors hover:text-foreground/80"
          >
            Automations
          </Link>
          <span className="text-muted-foreground"> › {truncateThreadName(title)}</span>
        </h2>
      }
    />
  );
}
