import type { ReactNode } from "react";

import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";

export function contentPanelHeaderClassName(className?: string) {
  return cn(
    "border-b border-border bg-[var(--app-shell-header-background)] px-3 backdrop-blur-[var(--app-shell-header-blur)] sm:px-5",
    isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
    className,
  );
}

interface ContentPanelHeaderProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function ContentPanelHeader({ children, className }: ContentPanelHeaderProps) {
  return <header className={contentPanelHeaderClassName(className)}>{children}</header>;
}
