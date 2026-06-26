import { SquarePenIcon } from "lucide-react";

import { cn } from "../lib/cn";

export function MobileNewChatFab({
  ariaLabel,
  className,
  onClick,
}: {
  ariaLabel: string;
  className?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cn(
        "fixed right-5 bottom-6 z-30 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95",
        className,
      )}
      onClick={onClick}
    >
      <SquarePenIcon className="size-6" />
    </button>
  );
}
