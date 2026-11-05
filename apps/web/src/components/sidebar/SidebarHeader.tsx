import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "../../config/env";
import { APP_STAGE_LABEL, APP_VERSION } from "../../config/branding";
import { SidebarHeader as UiSidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BigbudLogo } from "./SidebarProjectItem";

/**
 * The bigbud wordmark: links to threads and shows the version on hover. In the desktop app it also
 * shows the build stage (dev, nightly, beta) so you can tell builds apart at a glance.
 */
export function SidebarBrandLink({
  className,
  logoClassName,
}: {
  readonly className?: string;
  readonly logoClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label="Go to threads"
            className={cn(
              "flex min-w-0 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2",
              className,
            )}
            to="/"
          >
            <BigbudLogo {...(logoClassName ? { className: logoClassName } : {})} />
            {/* Only show the stage badge in the desktop Electron app. The web version has no badge. */}
            {isElectron && APP_STAGE_LABEL && (
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL.toLowerCase()}
              </span>
            )}
          </Link>
        }
      />
      <TooltipPopup side="bottom" sideOffset={2}>
        Version {APP_VERSION}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The top header bar of the sidebar. On desktop it is only the draggable title bar beside the
 * traffic lights and the window sidebar toggle; the wordmark lives in the sidebar footer there.
 * On the web it holds the mobile sidebar trigger and the wordmark.
 */
export function SidebarAppHeader() {
  if (isElectron) {
    return <UiSidebarHeader className="drag-region h-[52px] shrink-0 p-0" />;
  }

  return (
    <UiSidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="shrink-0 md:hidden" />
        <SidebarBrandLink className="ml-1 flex-1" />
      </div>
    </UiSidebarHeader>
  );
}
