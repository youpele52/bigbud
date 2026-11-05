import { QuillWrite01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function NewChatIcon({ className }: { className?: string }) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={className}
      icon={QuillWrite01Icon}
      size={14}
      strokeWidth={1.5}
    />
  );
}
