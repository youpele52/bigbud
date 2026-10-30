import { CloudIcon, Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopMinimalIcon } from "lucide-react";

import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import type { ItutuLocation } from "./Sidebar.itutu.logic";

const ICON_CLASS = `${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/60`;

/** The smaller second line of an Ìtútù row: Chat, a local project, or a remote workspace. */
export function SidebarItutuLocationLine({ location }: { location: ItutuLocation }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
      {location.kind === "local" ? (
        <LaptopMinimalIcon aria-hidden="true" className={ICON_CLASS} />
      ) : (
        <HugeiconsIcon
          aria-hidden="true"
          className={ICON_CLASS}
          icon={location.kind === "chat" ? Comment03Icon : CloudIcon}
          size={12}
          strokeWidth={1.5}
        />
      )}
      <span className="min-w-0 truncate">{location.label}</span>
    </span>
  );
}
