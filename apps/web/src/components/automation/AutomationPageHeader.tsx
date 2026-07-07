import type { ReactNode } from "react";

import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";

interface AutomationListPageHeaderProps {
  readonly actions?: ReactNode;
}

export function AutomationListPageHeader({ actions }: AutomationListPageHeaderProps) {
  return <StandaloneChatPageHeader actions={actions} title="Scheduled" />;
}

interface AutomationDetailPageHeaderProps {
  readonly actions?: ReactNode;
  readonly title: string;
}

export function AutomationDetailPageHeader({ actions, title }: AutomationDetailPageHeaderProps) {
  return (
    <StandaloneChatPageHeader
      actions={actions}
      backLabel="Scheduled"
      backTo="/automations"
      title={title}
    />
  );
}
