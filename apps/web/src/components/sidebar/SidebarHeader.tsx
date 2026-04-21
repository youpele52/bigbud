import { Link } from "@tanstack/react-router";
import { isElectron } from "../../config/env";
import { APP_STAGE_LABEL, APP_VERSION } from "../../config/branding";
import { SidebarHeader as UiSidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BigbudLogo } from "./SidebarProjectItem";

function SidebarWordmark() {
  return (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <BigbudLogo />
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL.toLowerCase()}
              </span>
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The top header bar of the sidebar, containing the T3 wordmark and version tooltip. */
export function SidebarAppHeader() {
  if (isElectron) {
    return (
      <UiSidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
        <SidebarWordmark />
      </UiSidebarHeader>
    );
  }

  return (
    <UiSidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
      <SidebarWordmark />
    </UiSidebarHeader>
  );
}
