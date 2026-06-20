import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ContentPanelHeaderBar } from "../layout/ContentPanelHeaderBar";
import { truncateThreadName } from "../sidebar/Sidebar.logic";

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
