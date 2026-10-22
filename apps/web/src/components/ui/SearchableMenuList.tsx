import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Searchbar } from "./Searchbar";

/**
 * Search field plus scrollable body for searchable menu popups (model picker, SSH hosts).
 * The caller owns filtering and renders the items, usually a `MenuRadioGroup`.
 */
export function SearchableMenuList({
  query,
  onQueryChange,
  placeholder,
  searchbarClassName,
  onBack,
  backAriaLabel,
  bodyProps,
  children,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  searchbarClassName?: string | undefined;
  onBack?: (() => void) | undefined;
  backAriaLabel?: string | undefined;
  bodyProps?: ComponentProps<"div"> | undefined;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex max-h-(--available-height) flex-col">
      <Searchbar
        sticky
        showSearchIcon={false}
        canClear={query.length > 0}
        onClear={() => {
          onQueryChange("");
          inputRef.current?.focus();
        }}
        onClick={() => {
          inputRef.current?.focus();
        }}
        {...(backAriaLabel ? { backAriaLabel } : {})}
        {...(searchbarClassName ? { className: searchbarClassName } : {})}
        {...(onBack ? { onBack } : {})}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            // Keep typing in the field instead of driving menu typeahead.
            event.stopPropagation();
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] tracking-tight text-foreground placeholder:text-[11px] placeholder:tracking-tight placeholder:text-muted-foreground/50 focus:outline-none"
        />
      </Searchbar>

      <div
        {...bodyProps}
        className={cn(
          "min-h-0 max-h-[min(14rem,var(--available-height))] flex-1 overflow-y-auto",
          bodyProps?.className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
