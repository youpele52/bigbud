import { XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";

type StatusBannerVariant = NonNullable<ComponentProps<typeof Alert>["variant"]>;

interface StatusBannerProps {
  readonly variant?: StatusBannerVariant;
  readonly icon?: ReactNode;
  readonly title?: ReactNode;
  readonly description: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function StatusBanner({
  variant = "default",
  icon,
  title,
  description,
  onDismiss,
  dismissLabel = "Dismiss",
  action,
  className,
}: StatusBannerProps) {
  const dismissButtonClassName =
    variant === "warning"
      ? "text-warning/60 hover:text-warning"
      : variant === "error"
        ? "text-destructive/60 hover:text-destructive"
        : "text-muted-foreground/60 hover:text-muted-foreground";

  return (
    <Alert className={className} variant={variant}>
      {icon}
      {title !== undefined && title !== null ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{description}</AlertDescription>
      {(action !== undefined && action !== null) || onDismiss ? (
        <AlertAction>
          {action}
          {onDismiss ? (
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
    </Alert>
  );
}
