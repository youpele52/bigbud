import { FolderIcon } from "lucide-react";

import { cn } from "../../lib/cn";
import { SIDEBAR_ICON_SIZE_CLASS } from "./threads.iconSizes";

export function MobileFolderIcon({ className }: { className?: string | undefined }) {
  return (
    <FolderIcon
      className={cn(SIDEBAR_ICON_SIZE_CLASS, "shrink-0 text-muted-foreground/70", className)}
    />
  );
}
