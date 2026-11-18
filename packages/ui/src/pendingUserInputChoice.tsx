import type { ReactNode } from "react";
import { cn } from "./cn";

/** Native grouping, arrows and checkbox activation stay with the browser. */
export function PendingUserInputChoice({
  type,
  name,
  checked,
  disabled,
  className,
  onToggle,
  children,
}: {
  readonly type: "radio" | "checkbox";
  readonly name: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly className?: string;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <label className={cn("text-sm", className)}>
      <input
        type={type}
        name={name}
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        // Checked radios have no change event; preserve pointer-click deselection.
        onClick={() => {
          if (type === "radio" && checked) onToggle();
        }}
      />
      {children}
    </label>
  );
}
