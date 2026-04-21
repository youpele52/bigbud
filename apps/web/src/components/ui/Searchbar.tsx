"use client";

import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

type SearchbarProps = {
  readonly children: React.ReactNode;
  readonly onBack?: () => void;
  readonly onClear?: () => void;
  readonly canClear?: boolean;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly backAriaLabel?: string;
  readonly clearAriaLabel?: string;
  readonly leading?: React.ReactNode;
  readonly trailing?: React.ReactNode;
  readonly sticky?: boolean;
  readonly hideDivider?: boolean;
  readonly showSearchIcon?: boolean;
};

export function Searchbar({
  children,
  onBack,
  onClear,
  canClear = false,
  className,
  contentClassName,
  backAriaLabel = "Back",
  clearAriaLabel = "Clear search",
  leading,
  trailing,
  sticky = false,
  hideDivider = false,
  showSearchIcon = true,
}: SearchbarProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 border-b bg-popover px-2 py-1.5",
        sticky && "sticky top-0 z-10",
        hideDivider && "border-b-0",
        className,
      )}
      data-slot="searchbar"
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          aria-label={backAriaLabel}
          data-slot="searchbar-back"
        >
          <ArrowLeftIcon className="size-3.5" />
        </button>
      ) : leading ? (
        <div
          className="flex shrink-0 items-center justify-center text-muted-foreground/70"
          data-slot="searchbar-leading"
        >
          {leading}
        </div>
      ) : showSearchIcon ? (
        <div
          className="flex shrink-0 items-center justify-center text-muted-foreground/60"
          data-slot="searchbar-leading"
        >
          <SearchIcon className="size-3.5" />
        </div>
      ) : null}
      <div className={cn("min-w-0 flex-1", contentClassName)} data-slot="searchbar-content">
        {children}
      </div>
      {canClear && onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          aria-label={clearAriaLabel}
          data-slot="searchbar-clear"
        >
          <XIcon className="size-3" />
        </button>
      ) : trailing ? (
        <div
          className="flex shrink-0 items-center justify-center text-muted-foreground/60"
          data-slot="searchbar-trailing"
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
