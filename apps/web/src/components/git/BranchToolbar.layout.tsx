import type { ReactNode } from "react";

/** Equal constrained tracks keep the workspace control centered, independent of its neighbors. */
export function BranchToolbarLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-[calc(52rem+theme(spacing.6))] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 px-8 pb-3 pt-1 sm:max-w-[calc(52rem+theme(spacing.10))] sm:px-12">
      {children}
    </div>
  );
}
