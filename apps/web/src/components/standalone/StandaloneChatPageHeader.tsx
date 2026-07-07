import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ContentPanelHeaderBar } from "../layout/ContentPanelHeaderBar";

interface StandaloneChatPageHeaderProps {
  readonly actions?: ReactNode;
  readonly title: string;
  readonly backLabel?: string;
  readonly backTo?: "/automations" | "/usage";
}

export function StandaloneChatPageHeader({
  actions,
  backLabel,
  backTo,
  title,
}: StandaloneChatPageHeaderProps) {
  return (
    <ContentPanelHeaderBar
      actions={actions}
      title={
        <h2 className="min-w-0 shrink truncate text-sm font-medium text-foreground" title={title}>
          {backLabel && backTo ? (
            <>
              <Link
                to={backTo}
                className="text-foreground transition-colors hover:text-foreground/80"
              >
                {backLabel}
              </Link>
              <span className="text-muted-foreground"> › {title}</span>
            </>
          ) : (
            title
          )}
        </h2>
      }
    />
  );
}
