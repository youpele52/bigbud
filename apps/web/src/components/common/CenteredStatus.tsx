import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { BigbudLogo } from "../sidebar/SidebarProjectItem";

/** Center the muted activity logo and sentence-case label; inactive states stay static. */
export function CenteredStatus({
  children,
  loading = false,
  className,
  role = "status",
}: {
  children: ReactNode;
  loading?: boolean;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div
      data-slot="centered-status"
      data-loading={loading ? "true" : "false"}
      role={role}
      className={cn(
        "flex w-full min-w-0 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {loading ? (
        <BigbudLogo
          decorative
          className="h-4 animate-breathe text-muted-foreground/40 motion-reduce:animate-none"
        />
      ) : null}
      <div className={cn("w-full min-w-0 break-words text-center", loading && "normal-case")}>
        {loading && typeof children === "string"
          ? children.charAt(0).toUpperCase() + children.slice(1)
          : children}
      </div>
    </div>
  );
}
