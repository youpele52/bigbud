import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Shared presentation for terminal find and rename controls; callers own positioning and behavior. */
export function TerminalInlineBar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex max-w-full items-center gap-1 rounded-xl border border-border bg-popover p-1 shadow-md",
        className,
      )}
      {...props}
    />
  );
}

export function TerminalInlineBarInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input size="sm" className={cn("w-52 min-w-0", className)} {...props} />;
}

export function TerminalInlineBarButton(props: ComponentProps<typeof Button>) {
  return <Button size="icon-xs" variant="toolbar" {...props} />;
}
