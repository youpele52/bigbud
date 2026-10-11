import { RoboticIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** Shares AI settings artwork while preserving each surface's CSS sizing. */
export function SettingsAiIcon({ className }: { className?: string }) {
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
