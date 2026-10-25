import { XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useBannerDismissal, type BannerIdentity } from "../../stores/ui/useBannerDismissal";
import { cn } from "../../lib/utils";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";

type StatusBannerVariant = NonNullable<ComponentProps<typeof Alert>["variant"]>;

interface StatusBannerContentProps extends Omit<
  ComponentProps<typeof Alert>,
  "title" | "children"
> {
  readonly variant?: StatusBannerVariant;
  readonly role?: ComponentProps<typeof Alert>["role"];
  readonly icon?: ReactNode;
  readonly title?: ReactNode;
  readonly description: ReactNode;
  readonly dismissLabel?: string;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly centered?: boolean;
  readonly descriptionProps?: ComponentProps<typeof AlertDescription>;
  readonly dismissPlacement?: "inline" | "corner";
}

export type StatusBannerProps = StatusBannerContentProps &
  (
    | { readonly dismissalKey: BannerIdentity; readonly onDismiss?: () => void }
    | { readonly dismissalKey?: never; readonly onDismiss: () => void }
  );

export function StatusBanner({
  variant = "default",
  role = "alert",
  icon,
  title,
  description,
  onDismiss,
  dismissalKey,
  dismissLabel = "Dismiss",
  action,
  className,
  centered = false,
  descriptionProps,
  dismissPlacement = "inline",
  ...alertProps
}: StatusBannerProps) {
  const session = useBannerDismissal(dismissalKey);
  if (session.dismissed) return null;
  const dismiss = () => {
    session.dismiss();
    onDismiss?.();
  };
  const dismissButtonClassName =
    variant === "warning"
      ? "text-warning/60 hover:text-warning"
      : variant === "error"
        ? "text-destructive/60 hover:text-destructive"
        : "text-muted-foreground/60 hover:text-muted-foreground";

  return (
    <Alert
      {...alertProps}
      className={cn(className, centered && "pt-4")}
      variant={variant}
      role={role}
    >
      {centered ? (
        <div className="col-span-full flex min-w-0 flex-col items-center gap-2 text-center">
          {icon || (title !== undefined && title !== null) ? (
            <div
              data-slot="alert-heading"
              className="flex min-w-0 items-center justify-center gap-3"
            >
              {icon ? <span className="shrink-0 [&>svg]:size-4">{icon}</span> : null}
              {title !== undefined && title !== null ? <AlertTitle>{title}</AlertTitle> : null}
            </div>
          ) : null}
          <AlertDescription {...descriptionProps}>{description}</AlertDescription>
        </div>
      ) : (
        <>
          {icon}
          {title !== undefined && title !== null ? <AlertTitle>{title}</AlertTitle> : null}
          <AlertDescription {...descriptionProps}>{description}</AlertDescription>
        </>
      )}
      {(action !== undefined && action !== null) || dismissPlacement === "inline" ? (
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
          {dismissPlacement === "inline" ? (
            <button
              type="button"
              aria-label={dismissLabel}
              className={`inline-flex size-6 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dismissButtonClassName}`}
              onClick={dismiss}
            >
              <XIcon className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </AlertAction>
      ) : null}
      {dismissPlacement === "corner" ? (
        <button
          type="button"
          aria-label={dismissLabel}
          className={`absolute right-3 top-3 inline-flex size-6 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dismissButtonClassName}`}
          onClick={dismiss}
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </Alert>
  );
}
