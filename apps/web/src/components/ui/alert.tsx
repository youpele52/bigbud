import type * as React from "react";
import { LoaderCircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  STATUS_SURFACE_BACKGROUNDS,
  statusSurfaceAccent,
  type StatusSurfaceTone,
} from "./statusSurface";

function Alert({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"div"> & { variant?: StatusSurfaceTone }) {
  return (
    <div
      className={cn(
        "relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-xl border px-3.5 py-3 text-card-foreground text-sm has-[>svg]:grid-cols-[1rem_minmax(0,1fr)_auto] [&>svg]:col-start-1 [&>svg]:row-start-1 [&>svg]:row-span-2 [&>svg]:h-lh [&>svg]:w-4 [&>svg]:text-muted-foreground",
        STATUS_SURFACE_BACKGROUNDS[variant],
        statusSurfaceAccent(variant),
        className,
      )}
      data-slot="alert"
      data-status={variant}
      role="alert"
      {...props}
    >
      {variant === "loading" ? (
        <LoaderCircleIcon className="animate-spin text-info-foreground!" aria-hidden />
      ) : null}
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "col-start-1 min-w-0 wrap-break-word font-medium [svg~&]:col-start-2",
        className,
      )}
      data-slot="alert-title"
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "col-start-1 flex min-w-0 flex-col gap-2.5 wrap-break-word text-muted-foreground [svg~&]:col-start-2",
        className,
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "col-start-2 row-start-1 row-span-2 flex flex-wrap gap-1 self-center [svg~&]:col-start-3",
        className,
      )}
      data-slot="alert-action"
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
