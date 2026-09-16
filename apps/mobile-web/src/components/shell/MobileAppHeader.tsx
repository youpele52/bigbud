import { SidebarBottomIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { MobileHeaderBreadcrumbSegment } from "../../logic/mobileHeader.logic";
import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import { BigbudLogo } from "./BigbudLogo";
import { cn } from "../../lib/cn";
import {
  describeMobileConnection,
  MOBILE_NAVIGATION_TRIGGER_ID,
} from "./MobileNavigationSheet.logic";

interface MobileAppHeaderProps {
  title?: string | undefined;
  breadcrumb?: ReadonlyArray<MobileHeaderBreadcrumbSegment> | undefined;
  showLogo?: boolean | undefined;
  showBack?: boolean | undefined;
  backTo?: string | undefined;
  trailing?: ReactNode | undefined;
  conversation?: boolean | undefined;
  conversationProviderIcon?: ReactNode | undefined;
  onOpenNavigation?: (() => void) | undefined;
  onNew?: (() => void) | undefined;
  connectionState?: MobileRecoveryState | undefined;
  connection?: MobileConnectionState | undefined;
  navigationOpen?: boolean | undefined;
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
  trailing,
  conversation = false,
  conversationProviderIcon,
  onOpenNavigation,
  onNew,
  connectionState,
  connection,
  navigationOpen = false,
}: MobileAppHeaderProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPairing = pathname.includes("/pair");

  if (isPairing) {
    return null;
  }

  const chatsLabel = connectionState
    ? `Open Chats. ${describeMobileConnection(connectionState, connection)}`
    : "Open Chats";

  return (
    <header className="sticky top-0 z-40 -mx-4 mb-4 border-b border-border bg-background px-3 py-2">
      <div className="flex min-h-8 items-center gap-2">
        {conversation ? (
          <Link
            aria-label="Go to bigbud home"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-primary transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            to="/mobile"
          >
            <BigbudLogo className="h-4" />
          </Link>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!conversation && showBack ? (
            <Link
              aria-label="Go back"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              to={backTo}
            >
              <ChevronLeftIcon className="size-5" />
            </Link>
          ) : null}
          {!conversation && showLogo ? (
            <Link
              aria-label="Go to bigbud home"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              to="/mobile"
            >
              <BigbudLogo className="h-7" />
            </Link>
          ) : null}
          {conversation && conversationProviderIcon ? (
            <span
              aria-hidden="true"
              className="inline-flex size-5 shrink-0 items-center justify-center"
              data-mobile-conversation-provider-icon="true"
            >
              {conversationProviderIcon}
            </span>
          ) : null}
          {!conversation && breadcrumb && breadcrumb.length > 0 ? (
            <MobileHeaderBreadcrumb segments={breadcrumb} />
          ) : title ? (
            <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          ) : conversation ? (
            <h1 className="truncate text-sm font-semibold text-foreground">New thread</h1>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {trailing}
          {onOpenNavigation ? (
            <button
              id={MOBILE_NAVIGATION_TRIGGER_ID}
              aria-expanded={navigationOpen}
              aria-haspopup="dialog"
              aria-label={chatsLabel}
              className="inline-flex size-11 items-center justify-center rounded-lg text-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              onClick={onOpenNavigation}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-4"
                icon={SidebarBottomIcon}
                size={16}
                strokeWidth={1.5}
              />
            </button>
          ) : null}
          {onNew ? (
            <button
              aria-label="New chat"
              className="inline-flex size-11 items-center justify-center rounded-lg text-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              onClick={onNew}
              type="button"
            >
              <PlusIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
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
  "mx-1 flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors active:bg-accent/50";

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
