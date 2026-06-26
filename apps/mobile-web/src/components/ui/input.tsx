import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "../../lib/cn";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "default" | "lg" | number;
};

function Input({ className, size = "default", ...props }: InputProps) {
  return (
    <span
      className={cn(
        "relative inline-flex w-full rounded-lg border border-input bg-background text-sm text-foreground shadow-xs/5 transition-[border-color,box-shadow] has-focus-visible:border-ring/45 has-disabled:opacity-64",
        className,
      )}
      data-size={size}
      data-slot="input-control"
    >
      <InputPrimitive
        className="h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] text-sm outline-none placeholder:text-muted-foreground/72 sm:h-7.5"
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        {...props}
      />
    </span>
  );
}

export { Input, type InputProps };
