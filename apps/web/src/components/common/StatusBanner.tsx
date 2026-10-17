import { XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";

type StatusBannerVariant = NonNullable<ComponentProps<typeof Alert>["variant"]>;

export interface StatusBannerProps extends Omit<
  ComponentProps<typeof Alert>,
  "title" | "children"
> {
  readonly variant?: StatusBannerVariant;
  readonly role?: ComponentProps<typeof Alert>["role"];
  readonly icon?: ReactNode;
  readonly title?: ReactNode;
  readonly description: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly centered?: boolean;
  readonly descriptionProps?: ComponentProps<typeof AlertDescription>;
  readonly dismissPlacement?: "inline" | "corner";
}

export function StatusBanner({
  variant = "default",
  role = "alert",
  icon,
  title,
  description,
  onDismiss,
  dismissLabel = "Dismiss",
  action,
  className,
  centered = false,
  descriptionProps,
  dismissPlacement = "inline",
  ...alertProps
}: StatusBannerProps) {
  const dismissButtonClassName =
    variant === "warning"
      ? "text-warning/60 hover:text-warning"
      : variant === "error"
        ? "text-destructive/60 hover:text-destructive"
        : "text-muted-foreground/60 hover:text-muted-foreground";

  return (
    <Alert {...alertProps} className={className} variant={variant} role={role}>
      {centered ? (
        <div className="col-span-full flex min-w-0 flex-col items-center gap-2 text-center">
          {icon ? <span className="[&>svg]:size-4">{icon}</span> : null}
          {title !== undefined && title !== null ? <AlertTitle>{title}</AlertTitle> : null}
          <AlertDescription {...descriptionProps}>{description}</AlertDescription>
        </div>
      ) : (
        <>
          {icon}
          {title !== undefined && title !== null ? <AlertTitle>{title}</AlertTitle> : null}
          <AlertDescription {...descriptionProps}>{description}</AlertDescription>
        </>
      )}
      {(action !== undefined && action !== null) || (onDismiss && dismissPlacement === "inline") ? (
        <AlertAction
          className={
            centered
              ? "absolute right-2 top-2"
              : dismissPlacement === "corner"
                ? "col-span-full col-start-1! row-auto! mt-2 flex-wrap"
                : undefined
          }
        >
          {action}
          {onDismiss && dismissPlacement === "inline" ? (
            <button
              type="button"
              aria-label={dismissLabel}
              className={`inline-flex size-6 items-center justify-center rounded-md transition-colors ${dismissButtonClassName}`}
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </AlertAction>
      ) : null}
      {onDismiss && dismissPlacement === "corner" ? (
        <button
          type="button"
          aria-label={dismissLabel}
          className={`absolute right-3 top-3 inline-flex size-6 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dismissButtonClassName}`}
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </Alert>
  );
}
