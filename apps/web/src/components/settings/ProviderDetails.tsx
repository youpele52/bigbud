import { useState, type ReactNode } from "react";

/** A passive disclosure: opening it never changes configuration or initiates setup. */
export function ProviderDetails({
  label,
  children,
  lazy = false,
}: {
  label: string;
  children: ReactNode;
  lazy?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <details
      className="text-xs text-muted-foreground"
      onToggle={lazy ? (event) => setIsOpen(event.currentTarget.open) : undefined}
    >
      <summary className="w-fit cursor-pointer rounded-sm font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {label}
      </summary>
      {!lazy || isOpen ? <div className="mt-2 space-y-2">{children}</div> : null}
    </details>
  );
}
