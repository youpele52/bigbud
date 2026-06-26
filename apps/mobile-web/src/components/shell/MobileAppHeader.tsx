import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { MobileHeaderBreadcrumbSegment } from "../../logic/mobileHeader.logic";
import { BigbudLogo } from "./BigbudLogo";
import { MobileHamburgerMenu } from "./MobileHamburgerMenu";
import { cn } from "../../lib/cn";

interface MobileAppHeaderProps {
  title?: string | undefined;
  breadcrumb?: ReadonlyArray<MobileHeaderBreadcrumbSegment> | undefined;
  showLogo?: boolean | undefined;
  showBack?: boolean | undefined;
  backTo?: string | undefined;
  onReconnect: () => void;
  onSignOut: () => void;
  trailing?: ReactNode | undefined;
}

function MobileHeaderBreadcrumb({
  segments,
}: {
  segments: ReadonlyArray<MobileHeaderBreadcrumbSegment>;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden text-sm">
      {segments.map((segment, index) => (
        <span key={segment.to ?? segment.label} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <span className="shrink-0 text-muted-foreground/45">&gt;</span> : null}
          {segment.to ? (
            <Link
              className="truncate text-foreground/80 transition-colors active:text-foreground"
              title={segment.label}
              to={segment.to}
            >
              {segment.label}
            </Link>
          ) : (
            <span className="truncate font-medium text-muted-foreground" title={segment.label}>
              {segment.label}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

export function MobileAppHeader({
  title,
  breadcrumb,
  showLogo = false,
  showBack = false,
  backTo = "/mobile",
  onReconnect,
  onSignOut,
  trailing,
}: MobileAppHeaderProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPairing = pathname.includes("/pair");

  if (isPairing) {
    return null;
  }

  return (
    <header className="sticky top-0 z-40 -mx-4 mb-4 border-b border-border/60 bg-background px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {showBack ? (
            <Link
              aria-label="Go back"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-accent"
              to={backTo}
            >
              <ChevronLeftIcon className="size-5" />
            </Link>
          ) : null}
          {showLogo ? (
            <Link className="inline-flex items-center text-foreground" to="/mobile">
              <BigbudLogo className="h-7" />
            </Link>
          ) : breadcrumb && breadcrumb.length > 0 ? (
            <MobileHeaderBreadcrumb segments={breadcrumb} />
          ) : title ? (
            <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {trailing}
          <MobileHamburgerMenu onReconnect={onReconnect} onSignOut={onSignOut} />
        </div>
      </div>
    </header>
  );
}

export function MobileListSection({
  title,
  icon,
  children,
  className,
}: {
  title?: string | undefined;
  icon?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={cn("py-1", className)}>
      {title ? (
        <h2 className="mb-1 mx-1 flex items-center gap-2 px-2 text-xs font-semibold text-muted-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </h2>
      ) : null}
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

const mobileListItemClassName =
  "mx-1 flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors active:bg-accent/50";

export function MobileListLink({
  to,
  params,
  children,
  icon,
}: {
  to: string;
  params?: Record<string, string>;
  children: ReactNode;
  icon?: ReactNode | undefined;
}) {
  return (
    <Link className={mobileListItemClassName} {...(params ? { params } : {})} to={to}>
      {icon ? (
        <span className="inline-flex shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

export function MobileListAction({
  onClick,
  children,
  icon,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      className={cn(mobileListItemClassName, "w-full text-left disabled:opacity-50")}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? (
        <span className="inline-flex shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
