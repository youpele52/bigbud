import type { ReactNode } from "react";

import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";

interface AutomationPageShellProps {
  readonly header: ReactNode;
  readonly children: ReactNode;
}

export function AutomationPageShell({ header, children }: AutomationPageShellProps) {
  return <StandaloneChatPageShell header={header}>{children}</StandaloneChatPageShell>;
}
