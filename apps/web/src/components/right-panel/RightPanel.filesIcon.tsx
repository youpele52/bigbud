import { Folder02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** Shares Files navigation artwork while leaving CSS sizing to each surface. */
export function RightPanelFilesIcon({ className }: { className?: string }) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={className}
      icon={Folder02Icon}
      size={14}
      strokeWidth={1.5}
    />
  );
}
