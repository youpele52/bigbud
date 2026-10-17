import { StructureFolderCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** The shared semantic icon for physical and pending worktrees. */
export function WorktreeIcon({ className }: { className?: string }) {
  return (
    <HugeiconsIcon
      icon={StructureFolderCircleIcon}
      className={className ?? "size-3"}
      aria-hidden="true"
    />
  );
}
