import { RoboticIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function AiIcon({ className }: { className?: string | undefined }) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={className}
      icon={RoboticIcon}
      size={14}
      strokeWidth={2}
    />
  );
}
